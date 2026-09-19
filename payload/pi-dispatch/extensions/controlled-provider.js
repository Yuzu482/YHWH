// SPDX-License-Identifier: Apache-2.0
import { registrationConfig } from '../scripts/controlled-provider.mjs';
export default function controlledProvider(pi) {
  const packet=globalThis[Symbol.for('yhwh.controlledProvider')];
  if (!packet) throw new Error('PI_PROVIDER_BOOTSTRAP_REQUIRED');
  pi.registerProvider(packet.provider, registrationConfig(packet.route));
}
