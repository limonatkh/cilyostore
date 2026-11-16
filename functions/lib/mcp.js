'use strict';
// نقطة MCP عبر HTTP: مساعد الـAI (Claude Code، Copilot، …) بيتصل فيها برمز الموصل.
const { AppError } = require('./ctx');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = (description) => ({ type: 'string', description });
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const PROJECT = str('Project id from cilyo_list_projects');

const TOOL_DEFS = [
  {
    name: 'cilyo_list_projects',
    description: 'List the Cilyo projects the user participates in, with ids. Call this first to find the project_id. Content is usually in Arabic.',
    inputSchema: schema({}, [])
  },
  {
    name: 'cilyo_project_context',
    description:
      "Get everything about a project before working on it: the repo, the participants, the roles (who is responsible for what, and which are the user's), the agreements between roles with their status (proposed, agreed, implemented, approved, rejected), open approval requests, and recent trial builds. Respect role ownership: do not change work that belongs to a role held by someone else without an agreement.",
    inputSchema: schema({ project_id: PROJECT }, ['project_id'])
  },
  {
    name: 'cilyo_propose_agreement',
    description:
      'Propose a new agreement between two roles: something one role provides that another relies on (an event, a function, a data shape, a file format, or a rule such as "the player jumps 2 meters"). It starts as proposed and the affected role holders must approve it in Cilyo. Write in the language the team uses (usually Arabic).',
    inputSchema: schema(
      {
        project_id: PROJECT,
        title: str('Short name of the agreement'),
        description: str('What exactly is promised: names, data, conditions'),
        from_role: str('Role that provides it (role id or exact name)'),
        to_role: str('Role that relies on it (role id or exact name)')
      },
      ['project_id', 'title', 'from_role', 'to_role']
    )
  },
  {
    name: 'cilyo_update_agreement',
    description: "Change an existing agreement's title or description. This sends it back to \"proposed\" for approval. Use it before changing work that would break an agreement.",
    inputSchema: schema({ project_id: PROJECT, agreement_id: str('Agreement id'), title: str('New title'), description: str('New description') }, ['project_id', 'agreement_id'])
  },
  {
    name: 'cilyo_set_agreement_status',
    description: 'Mark an agreement "implemented" (the providing role finished it) or "approved" (the relying role checked it works). Only after the work is really done and tested.',
    inputSchema: schema({ project_id: PROJECT, agreement_id: str('Agreement id'), status: { type: 'string', enum: ['implemented', 'approved'] } }, ['project_id', 'agreement_id', 'status'])
  },
  {
    name: 'cilyo_read_chat',
    description: "Read recent messages from the project's private chat to see what partners said.",
    inputSchema: schema({ project_id: PROJECT, limit: { type: 'number', description: 'How many recent messages, up to 100' } }, ['project_id'])
  },
  {
    name: 'cilyo_post_message',
    description: "Post a short message in the project's private chat, for example to tell partners a part is ready. It is marked as sent by the user's assistant.",
    inputSchema: schema({ project_id: PROJECT, text: str('The message') }, ['project_id', 'text'])
  },
  {
    name: 'cilyo_post_trial_link',
    description: 'Share a link where partners can try the current version (for example a GitHub Pages URL or a preview video). Links are for testing; only uploaded zip builds can be published to the store.',
    inputSchema: schema({ project_id: PROJECT, url: str('The link'), note: str('What changed in this version') }, ['project_id', 'url'])
  },
  {
    name: 'cilyo_decide_approval',
    description: "Approve or reject an open approval request that needs this user's decision. ONLY call this when the user explicitly tells you their decision in the conversation; never decide on your own.",
    inputSchema: schema({ project_id: PROJECT, approval_id: str('Approval id'), decision: { type: 'string', enum: ['yes', 'no'] } }, ['project_id', 'approval_id', 'decision'])
  }
];

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

function makeMcpHandler(connector, logger) {
  async function handleOne(uid, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(msg && msg.id, -32600, 'Invalid Request');
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};
    let out;
    if (msg.method === 'initialize') {
      out = result(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cilyo', version: '1.0.0' },
        instructions:
          "Cilyo is a shared studio for teams. Before working, call cilyo_list_projects then cilyo_project_context. Only change work inside the user's own roles; for anything another role relies on, propose or update an agreement and let the partner approve it."
      });
    } else if (msg.method === 'ping') {
      out = result(msg.id, {});
    } else if (msg.method === 'tools/list') {
      out = result(msg.id, { tools: TOOL_DEFS });
    } else if (msg.method === 'tools/call') {
      const tool = Object.prototype.hasOwnProperty.call(connector.tools, params.name) ? connector.tools[params.name] : null;
      if (!tool) {
        out = error(msg.id, -32602, 'Unknown tool: ' + params.name);
      } else {
        try {
          const data = await tool(uid, params.arguments || {});
          out = result(msg.id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
        } catch (err) {
          if (!(err instanceof AppError)) logger.error(err);
          out = result(msg.id, { content: [{ type: 'text', text: err instanceof AppError ? err.message : 'خطأ داخلي' }], isError: true });
        }
      }
    } else if (msg.method.startsWith('notifications/')) {
      return null;
    } else {
      out = error(msg.id, -32601, 'Method not found: ' + msg.method);
    }
    return isNotification ? null : out;
  }

  return async function mcp(req, res) {
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      res.status(405).end();
      return;
    }
    const auth = req.headers.authorization || '';
    const uid = await connector.uidForToken(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (!uid) {
      res.status(401).json(error(null, -32001, 'رمز الموصل غلط أو ناقص. اعمل رمز جديد من صفحة «ربط المساعد» بـCilyo.'));
      return;
    }
    const body = req.body;
    if (Array.isArray(body)) {
      const outs = [];
      for (const m of body.slice(0, 20)) {
        const out = await handleOne(uid, m);
        if (out) outs.push(out);
      }
      if (outs.length) res.json(outs);
      else res.status(202).end();
      return;
    }
    const out = await handleOne(uid, body);
    if (out) res.json(out);
    else res.status(202).end();
  };
}

module.exports = { makeMcpHandler, TOOL_DEFS };
