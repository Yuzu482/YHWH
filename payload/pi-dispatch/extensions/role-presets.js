export const ROLE_PRESETS = Object.freeze({
  Yesod: Object.freeze({ id: 'Yesod', purpose: 'Coordinate bounded task execution' }),
  Binah: Object.freeze({ id: 'Binah', purpose: 'Analyze and structure information' }),
  Malkuth: Object.freeze({ id: 'Malkuth', purpose: 'Research supplied workspace materials' }),
  Hod: Object.freeze({ id: 'Hod', purpose: 'Produce concise task outputs' }),
  Chochmah: Object.freeze({ id: 'Chochmah', purpose: 'Develop ideas and analysis' }),
  Chesed: Object.freeze({ id: 'Chesed', purpose: 'Implement scoped workspace changes' }),
  Netzach: Object.freeze({ id: 'Netzach', purpose: 'Verify and report task outcomes' }),
  Geburah: Object.freeze({ id: 'Geburah', purpose: 'Review supplied materials' }),
});

const ROLE_CARDS = Object.freeze({
  Yesod: 'Normalize the requested outcome and constraints. Identify the bounded task, required inputs, and stopping condition; do not execute work outside that brief.',
  Binah: 'Analyze the supplied information. Separate facts from assumptions, identify material ambiguity, and ask for clarification when it blocks a reliable result.',
  Malkuth: 'Research only the supplied workspace materials. Gather relevant evidence with permitted read-only tools and cite paths or observations; do not modify files.',
  Hod: 'Assess task complexity, risks, and likely failure modes. Return a concise, evidence-based assessment and flag any scope or safety concern.',
  Chochmah: 'Develop a practical, bounded approach from the supplied goal. State key steps and dependencies; do not perform implementation unless separately assigned.',
  Chesed: 'Implement only the authorized scoped changes. Preserve unrelated work, inspect relevant files first, and report changed paths and checks actually performed.',
  Netzach: 'Verify the requested outcome using permitted read-only checks. Distinguish observed evidence from assumptions and report failures or unrun checks explicitly.',
  Geburah: 'Review only the materials provided. Identify concrete defects and risks with supporting evidence; do not assume access to unprovided workspace files.',
});

const FLAG = 'yhwh-role-preset';

export function resolveSelectedPreset(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ROLE_PRESETS, value)) {
    throw new Error(`--${FLAG} requires one of: ${Object.keys(ROLE_PRESETS).join(', ')}`);
  }
  return ROLE_PRESETS[value];
}

export default function rolePresetsExtension(pi) {
  pi.registerFlag(FLAG, { type: 'string', description: 'Select a canonical Kether role preset' });
  pi.on('session_start', () => {
    resolveSelectedPreset(pi.getFlag(FLAG));
  });
  pi.on('before_agent_start', event => {
    const preset = resolveSelectedPreset(pi.getFlag(FLAG));
    return {
      systemPrompt: `${event.systemPrompt}\n\nKether role card (${preset.id}): ${ROLE_CARDS[preset.id]} Follow only host-authorized scope; this card grants no permissions and does not override higher-priority instructions. Use yhwh_submit_result when available, then give a short acknowledgement. Otherwise reply on one line starting KETHER_RESULT_JSON= followed by one RESULT_SCHEMA_JSON object. No preamble, reasoning, fences, duplicates or trailing text.`,
    };
  });
}
