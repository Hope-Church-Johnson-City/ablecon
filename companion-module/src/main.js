// Ablecon module for Bitfocus Companion: control Ablecon (and through it,
// Ableton Live) from a Stream Deck or any other Companion surface.

import { InstanceBase, InstanceStatus } from '@companion-module/base';
import { AbleconClient } from './client.js';
import { actionDefinitions, feedbackDefinitions, presetDefinitions } from './definitions.js';
import { checks, commandFor, variableDefinitions, variableValues } from './logic.js';
import { UpgradeScripts } from './upgrades.js';

export { UpgradeScripts };

const DEFAULT_PORT = 8420;

export default class AbleconInstance extends InstanceBase {
  constructor(internal) {
    super(internal);
    this.client = null;
    this.config = {};
    this.lastValues = {};
  }

  async init(config) {
    this.config = config;
    this.setVariableDefinitions(variableDefinitions());
    this.setActionDefinitions(actionDefinitions((id, options) => this.runAction(id, options)));
    this.setFeedbackDefinitions(feedbackDefinitions((id, options) => this.check(id, options)));
    this.updatePresets();
    this.connect();
  }

  async destroy() {
    this.client?.stop();
    this.client = null;
  }

  async configUpdated(config) {
    this.config = config;
    this.updatePresets();
    this.connect();
  }

  getConfigFields() {
    return [
      {
        type: 'static-text',
        id: 'info',
        width: 12,
        label: '',
        value: 'Connects to the Ablecon app. If Ablecon runs on this same computer, keep 127.0.0.1. Otherwise use the address Ablecon shows under File → Open on Other Devices.',
      },
      { type: 'textinput', id: 'host', label: 'Ablecon address', width: 8, default: '127.0.0.1' },
      { type: 'number', id: 'port', label: 'Port', width: 4, default: DEFAULT_PORT, min: 1, max: 65535, asInteger: true },
    ];
  }

  connect() {
    this.client?.stop();
    const host = String(this.config.host || '127.0.0.1').trim();
    const port = Number(this.config.port) || DEFAULT_PORT;
    this.updateStatus(InstanceStatus.Connecting, `Connecting to Ablecon at ${host}:${port}`);
    this.client = new AbleconClient({
      host,
      port,
      onChange: () => this.refresh(),
      onStatus: (up, error) => {
        if (up) this.updateStatus(InstanceStatus.Ok);
        else this.updateStatus(InstanceStatus.ConnectionFailure, error ?? 'Not connected to Ablecon');
        this.refresh();
      },
      onNotice: (text, level) => this.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `Ablecon: ${text}`),
    });
    this.client.start();
  }

  updatePresets() {
    const { structure, presets } = presetDefinitions(this.label || 'ablecon');
    this.setPresetDefinitions(structure, presets);
  }

  /** Push changed variable values and re-check feedbacks after Ablecon reports something new. */
  refresh() {
    const c = this.client;
    const values = variableValues(c?.state ?? null, c?.position ?? null, !!c?.connected);
    const changed = {};
    for (const [k, val] of Object.entries(values)) {
      if (this.lastValues[k] !== val) changed[k] = val;
    }
    if (Object.keys(changed).length) {
      this.lastValues = values;
      this.setVariableValues(changed);
    }
    this.checkAllFeedbacks();
  }

  check(feedbackId, options) {
    const c = this.client;
    const fn = checks[feedbackId];
    return fn ? fn(c?.state ?? null, c?.position ?? null, !!c?.connected, options ?? {}) : false;
  }

  async runAction(actionId, options) {
    const c = this.client;
    const [action, extra] = commandFor(actionId, options ?? {}, c?.state ?? null);
    try {
      await c.send(action, extra);
    } catch (err) {
      this.log('warn', `${actionId}: ${err.message}`);
    }
  }
}
