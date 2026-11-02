---
name: adc-setup
description: Guide first use of ADC in this harness, including connection, human sign-in, device setup and scoped authorization.
---

# Connect ADC

Check the harness's ADC connection first. Installing a plugin does not sign in, pair a device
or authorize work. State the next missing step plainly.

For an MCP-capable host, open its ADC server connection/authentication entry. The user signs
in on ADC and chooses an existing authorization on the consent page. For Zion, open the ADC
sidebar and use Connect ADC; choose a device after returning to Zion.

When device setup or access changes are requested, use the bundled `agent-device-cloud`
Skill's getting-started and account/device-management references. It supports CLI installation
without preinstalled Node.js. Reuse existing devices and access, and let the human confirm
browser sign-in and authorization. Never ask the user to paste a token into chat.

For OpenCode, Pi and Cline's executable adapter, check `adc_status`. These local adapters use
the public `adc` CLI and its scoped Agent connection. Guide `adc login` and `adc connect`
through the bundled setup references if the requested setup requires them.

Verify live device/tool discovery and one harmless read-only result. Explain installed,
connected and ready independently, then use the `adc` workflow for ordinary work.
