/** Human-only text. Never include tokens, credentials or profile contents. */
import type { CliIo } from '../cli/io.js';
import type { ClientKind } from './clientConfig.js';
export async function ownerLabels(io:CliIo):Promise<{account:string;user:string}> {
  io.err('Account id is a local label for this Telegram account, not its Telegram username. Press Enter for personal.');
  const account=(await io.prompt('Gateway account id [personal]: ')).trim()||'personal';
  io.err('User id names this gateway permission profile, not your OS login. Press Enter for owner.');
  const user=(await io.prompt('Gateway user id [owner]: ')).trim()||'owner';return {account,user};
}
export const apiInstructions=[
  'Open https://my.telegram.org/apps and sign in with your Telegram phone number.',
  'Choose API development tools and create an application using a descriptive title and short name.',
  'Copy api_id and api_hash into the hidden prompts here. Keep codes/passwords out of chat and screenshots.',
];
export function nextSteps(io:CliIo,clients:ClientKind[],verified:boolean):void {
  if(!verified){io.err('No client connection was verified. Run tg-mcp-owner setup again and select a client; keep existing state.');return;}
  const labels={codex:'Codex Desktop/CLI',claude:'Claude Code',opencode:'OpenCode',hermes:'Hermes'};
  io.err('Setup complete: the service and authenticated MCP connection were verified.');
  io.err(`Close and reopen ${clients.map(c=>labels[c]).join(', ')}; start a fresh conversation.`);
  io.err('Ask: Use the telegram_gateway MCP server to call tg_status. An actual tool call confirms model tool loading.');
  io.err('Private chats and writes remain disabled by default. No token needs to be copied.');
}
