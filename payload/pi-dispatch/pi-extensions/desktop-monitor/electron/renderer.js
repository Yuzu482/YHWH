const $ = id => document.getElementById(id);
const connection = $('connection');
const controls = { search: $('taskSearch'), state: $('stateFilter'), active: $('activeOnly') };
let latest = { ok: false, message: '等待数据' };
let staleTimer;
let selectedRequestId = null;
const detailPanel = document.querySelector('.detail-panel');
const placeholder = detailPanel.querySelector('.detail-placeholder');
const detail = document.createElement('div');
detail.className = 'task-detail';
detail.hidden = true;
detailPanel.insertBefore(detail, detailPanel.querySelector('.detail-foot'));

const monitorTab = $('monitorTab');
const configTab = $('configTab');
const monitorView = $('monitorView');
const configView = $('configView');
const configForm = $('configForm');
const configFields = $('configFields');
const configStatus = $('configStatus');
const effectiveStatus = $('effectiveStatus');
const saveButton = $('saveConfig');
const reloadButton = $('reloadConfig');
const configInputs = ['maxConcurrency', 'maxQueue', 'maxRequestBytes'].map($);
let configRevision;
let configLoaded = false;
let configBusy = false;
let configDirty = false;
let currentView = 'monitor';

function setView(view) {
  currentView = view;
  const config = view === 'config';
  monitorView.hidden = config; configView.hidden = !config;
  monitorTab.setAttribute('aria-selected', String(!config));
  configTab.setAttribute('aria-selected', String(config));
  if (config && !configLoaded) loadConfig();
}
monitorTab.addEventListener('click', () => setView('monitor'));
configTab.addEventListener('click', () => setView('config'));

function setConfigBusy(busy) {
  configBusy = busy;
  configFields.disabled = busy;
  saveButton.disabled = busy || !configLoaded || !configDirty;
  reloadButton.disabled = busy;
  saveButton.textContent = busy ? '正在保存…' : '保存配置';
}
function setConfigMessage(message) { configStatus.textContent = message; }
function configValues() {
  return Object.fromEntries(configInputs.map(input => [input.name, Number(input.value)]));
}
function validConfig(settings) {
  const bounds = { maxConcurrency: [1, 4], maxQueue: [1, 64], maxRequestBytes: [1024, 1048576] };
  return settings && typeof settings === 'object' && configInputs.every(input => {
    const value = settings[input.name], [min, max] = bounds[input.name];
    return Number.isInteger(value) && value >= min && value <= max;
  });
}
function updateDirty() {
  if (!configLoaded || configBusy) return;
  configDirty = configInputs.some(input => input.value !== input.dataset.saved);
  setConfigBusy(false);
  if (configDirty) setConfigMessage('有未保存的更改。');
  else setConfigMessage('配置已保存。');
}
async function loadConfig() {
  if (configBusy) return;
  configBusy = true; configFields.disabled = true; reloadButton.disabled = true; saveButton.disabled = true;
  setConfigMessage('正在读取配置…');
  try {
    const result = await window.monitor.readConfig();
    if (!result || result.ok !== true || !validConfig(result.settings)) {
      configLoaded = false; configRevision = undefined;
      effectiveStatus.textContent = '';
      setConfigMessage(result?.code === 'CONFIG_IO' ? '读取配置失败，请稍后重试。' : '无法读取有效配置，请稍后重试。');
      return;
    }
    configRevision = result.revision; configLoaded = true; configDirty = false;
    for (const input of configInputs) { input.value = String(result.settings[input.name]); input.dataset.saved = input.value; }
    effectiveStatus.textContent = '已保存配置已加载。无法从此处确认网关当前生效值。';
    setConfigMessage('配置已加载并保存。');
  } catch {
    configLoaded = false; configRevision = undefined; effectiveStatus.textContent = '';
    setConfigMessage('读取配置失败，请稍后重试。');
  } finally {
    configBusy = false; configFields.disabled = !configLoaded; reloadButton.disabled = false;
    saveButton.disabled = !configLoaded || !configDirty;
  }
}
configInputs.forEach(input => input.addEventListener('input', updateDirty));
reloadButton.addEventListener('click', () => {
  if (configDirty && !window.confirm('重新加载将丢弃未保存的更改。继续？')) return;
  configDirty = false;
  loadConfig();
});
configForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (configBusy || !configLoaded) return;
  const values = configValues();
  for (const input of configInputs) {
    const value = values[input.name];
    if (!input.value.trim() || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
      input.setAttribute('aria-invalid', 'true'); input.reportValidity();
      setConfigMessage('请检查输入值是否为范围内的整数。'); input.focus(); return;
    }
    input.removeAttribute('aria-invalid');
  }
  configBusy = true; setConfigBusy(true); setConfigMessage('正在保存配置…');
  try {
    const result = await window.monitor.saveConfig(values, configRevision);
    if (result?.ok === true && validConfig(result.settings)) {
      configRevision = result.revision; configLoaded = true; configDirty = false;
      for (const input of configInputs) { input.value = String(result.settings[input.name]); input.dataset.saved = input.value; }
      effectiveStatus.textContent = '配置已保存；重启后生效。';
      setConfigMessage('保存成功。');
    } else if (result?.code === 'CONFIG_STALE') {
      configDirty = true;
      effectiveStatus.textContent = '';
      setConfigMessage('配置已被其他操作更改。草稿已保留；请重新加载以查看最新配置。');
    } else if (result?.code === 'CONFIG_IO') {
      configDirty = true; setConfigMessage('保存结果可能不确定。草稿已保留；请重新加载并核实配置。');
    } else if (result?.code === 'CONFIG_INVALID') {
      configDirty = true; setConfigMessage('配置未被接受，请检查数值范围后重试。');
    } else {
      configDirty = true; setConfigMessage('保存失败，请稍后重试。');
    }
  } catch {
    configDirty = true; setConfigMessage('保存失败，请稍后重试。');
  } finally {
    configBusy = false; configFields.disabled = !configLoaded;
    saveButton.disabled = !configLoaded || !configDirty; reloadButton.disabled = false;
  }
});

function validTask(task) {
  return task && typeof task === 'object' && !Array.isArray(task);
}
function renderDetail(task) {
  if (!task) {
    detail.hidden = true;
    placeholder.hidden = false;
    return;
  }
  placeholder.hidden = true;
  detail.hidden = false;
  detail.replaceChildren();
  const fields = [
    ['角色', task.role || '任务'], ['状态', task.state || '未知'],
    ['请求 ID', task.requestId || '无 ID'], ['路由', task.route || '路由未知'],
    ['已耗时', `${Math.max(0, Number(task.seconds) || 0)} 秒`]
  ];
  for (const [label, value] of fields) {
    const row = document.createElement('div');
    row.className = 'task-detail-row';
    const name = document.createElement('span'); name.textContent = label;
    const content = document.createElement('strong'); content.textContent = String(value);
    row.append(name, content); detail.append(row);
  }
}
function renderView() {
  const focusedTask = document.activeElement?.classList.contains('task-card')
    ? document.activeElement.getAttribute('data-request-id') : null;
  const ok = latest.ok === true;
  $('active').textContent = ok ? String(Number(latest.active) || 0) : '—';
  $('queued').textContent = ok ? String(Number(latest.queued) || 0) : '—';
  $('rss').textContent = ok ? String(Number(latest.rssMiB) || 0) : '—';
  const updated = ok ? new Date(latest.updatedAt) : null;
  $('updated').textContent = ok ? `更新于 ${Number.isNaN(updated.getTime()) ? '时间未知' : updated.toLocaleTimeString()}` : '等待网关恢复';
  const query = controls.search.value.trim().toLocaleLowerCase();
  const stateFilter = controls.state.value;
  const tasks = ok && Array.isArray(latest.tasks) ? latest.tasks.filter(validTask).filter(task => {
    const state = String(task.state || '').toLowerCase();
    const active = state === 'active' || state === 'running';
    const queued = state === 'queued';
    if (controls.active.checked && !active) return false;
    if (stateFilter === 'active' && !active || stateFilter === 'queued' && !queued) return false;
    return !query || [task.role, task.state, task.requestId, task.route].some(value => String(value ?? '').toLocaleLowerCase().includes(query));
  }) : [];
  const list = $('tasks'); list.replaceChildren();
  for (const task of tasks) {
    const id = task.requestId == null ? '' : String(task.requestId);
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'task-card'; button.setAttribute('data-request-id', id); button.setAttribute('aria-pressed', String(Boolean(id && id === selectedRequestId)));
    const heading = document.createElement('span'); heading.className = 'task-heading';
    const role = document.createElement('strong'); role.textContent = task.role || '任务';
    const state = document.createElement('span'); state.className = 'task-state'; state.textContent = task.state || '未知';
    heading.append(role, state);
    const route = document.createElement('span'); route.className = 'route'; route.textContent = task.route || '路由未知';
    const info = document.createElement('span'); info.className = 'details';
    info.textContent = `${id || '无 ID'} · ${Math.max(0, Number(task.seconds) || 0)} 秒`;
    button.append(heading, route, info);
    button.addEventListener('click', () => { selectedRequestId = id || null; renderView(); });
    list.append(button);
  }
  const selected = selectedRequestId && tasks.find(task => String(task.requestId ?? '') === selectedRequestId);
  renderDetail(selected || null);
  if (!selected && !latest.tasks?.some(task => String(task?.requestId ?? '') === selectedRequestId)) selectedRequestId = null;
  if (focusedTask !== null) {
    const replacement = focusedTask && [...list.querySelectorAll('.task-card')].find(button => button.getAttribute('data-request-id') === focusedTask);
    if (replacement) replacement.focus({ preventScroll: true });
  }
  const empty = $('empty');
  empty.hidden = tasks.length > 0;
  empty.textContent = !ok ? '离线时暂不显示任务' : (Array.isArray(latest.tasks) && latest.tasks.length ? '当前筛选条件下没有任务' : '尚无任务');
}
function render(snapshot) {
  const valid = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && snapshot.ok === true && Array.isArray(snapshot.tasks);
  latest = valid ? snapshot : { ok: false };
  connection.textContent = valid ? '已连接' : '离线 · 自动重连中';
  connection.className = `status ${valid ? 'online' : 'offline'}`;
  renderView();
  clearTimeout(staleTimer);
  if (valid) staleTimer = setTimeout(() => render({ ok: false }), 10000);
}
controls.search.addEventListener('input', renderView);
controls.state.addEventListener('change', renderView);
controls.active.addEventListener('change', renderView);
window.monitor.onStatus(render);
