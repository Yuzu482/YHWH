// Controlled no-tools provider. Installation metadata is verified by the FD bootstrap.
import { createClaudeStream } from '/opt/pi-kether/node_modules/pi-claude-code-provider/src/provider.ts';
import { providerModelsForSubscription } from '/opt/pi-kether/node_modules/pi-claude-code-provider/src/catalog.ts';
export default function(pi: any) {
  const installation = (globalThis as any)[Symbol.for('pi-kether.claude-installation')];
  if (!installation) throw new Error('Claude requires the secure sandbox bootstrap');
  const base = providerModelsForSubscription(installation.subscriptionType).find(m => m.id === 'sonnet');
  pi.registerProvider('pi-claude-code-provider', {
    name:'Claude Sonnet 5 Review', baseUrl:'pi-claude-code-provider://local',
    apiKey:'pi-claude-code-provider-subscription', api:'pi-claude-code-provider-headless',
    models:[{...base,id:'claude-sonnet-5',name:'Claude Sonnet 5'}],
    streamSimple:createClaudeStream(installation),
  });
}
