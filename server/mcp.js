// موصل المساعد: نقطة MCP عبر HTTP على /mcp
// المساعد (Claude Code، Copilot، ...) بيتصل فيها برمز الموصل تبع المستخدم،
// وبيستخدم نفس قواعد الموقع بالضبط.
const core = require('./core');
const store = require('./db');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'cilyo_list_studios',
    description:
      'List the Cilyo studios the user belongs to, with their projects and ids. Call this first to find the project_id to work on. Studio content is in Arabic.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (user) => {
      const { studios, invites } = core.listStudios(user);
      return { you: user.username, studios, pendingInvites: invites };
    }
  },
  {
    name: 'cilyo_project_context',
    description:
      'Get everything about a studio project before coding: the GitHub repo, the layers (parts of the game) and who owns each one, the user\'s own layers, the agreements between layers with their status (proposed, agreed, implemented, approved, rejected), open approval requests, and recent trial builds. Respect layer ownership: do not change code that belongs to a layer owned by someone else without an agreement.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project id from cilyo_list_studios' } },
      required: ['project_id'],
      additionalProperties: false
    },
    run: (user, a) => core.projectContext(user, a.project_id)
  },
  {
    name: 'cilyo_propose_agreement',
    description:
      'Propose a new agreement between two layers: something one layer provides that another layer relies on (an event, a function, a data shape, or a gameplay rule such as "the player jumps 2 meters"). It starts as proposed and the affected layer owners must approve it in Cilyo. Write title and description in the language the studio uses (usually Arabic).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string', description: 'Short name of the agreement' },
        description: { type: 'string', description: 'What exactly is promised: names, data, conditions' },
        from_layer: { type: 'string', description: 'Layer that provides it (layer id like L2, or its name)' },
        to_layer: { type: 'string', description: 'Layer that relies on it (layer id or name)' }
      },
      required: ['project_id', 'title', 'from_layer', 'to_layer'],
      additionalProperties: false
    },
    run: (user, a) =>
      core.proposeAgreement(
        user,
        a.project_id,
        { title: a.title, description: a.description, fromLayer: a.from_layer, toLayer: a.to_layer },
        { viaAI: true }
      )
  },
  {
    name: 'cilyo_update_agreement',
    description:
      'Change an existing agreement\'s title or description. This sends it back to "proposed" and asks the affected layer owners to approve again. Use it before changing code that breaks an agreement.',
    inputSchema: {
      type: 'object',
      properties: {
        agreement_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['agreement_id'],
      additionalProperties: false
    },
    run: (user, a) =>
      core.editAgreement(user, a.agreement_id, { title: a.title, description: a.description }, { viaAI: true })
  },
  {
    name: 'cilyo_set_agreement_status',
    description:
      'Mark an agreement as "implemented" (the providing layer\'s owner finished building it) or "approved" (the relying layer\'s owner checked it works). Only do this after the work is really done and tested.',
    inputSchema: {
      type: 'object',
      properties: {
        agreement_id: { type: 'string' },
        status: { type: 'string', enum: ['implemented', 'approved'] }
      },
      required: ['agreement_id', 'status'],
      additionalProperties: false
    },
    run: (user, a) => core.setAgreementStatus(user, a.agreement_id, a.status, { viaAI: true })
  },
  {
    name: 'cilyo_read_channel',
    description:
      'Read recent messages from a chat channel in the studio\'s private server (for example general, or a layer channel) to see what partners said.',
    inputSchema: {
      type: 'object',
      properties: {
        studio_id: { type: 'string' },
        channel: { type: 'string', description: 'Channel id or name, e.g. general or عام' },
        limit: { type: 'number', description: 'How many recent messages, up to 100' }
      },
      required: ['studio_id'],
      additionalProperties: false
    },
    run: (user, a) => {
      const st = core.requireMember(user, a.studio_id);
      core.requireActive(st);
      const ch = core.studioChatChannel(st, a.channel);
      return core
        .listMessages(user, st.serverId, ch.id, Math.min(100, a.limit || 30))
        .map((m) => ({ author: m.author, text: m.text, at: new Date(m.createdAt).toISOString() }));
    }
  },
  {
    name: 'cilyo_post_message',
    description:
      'Post a short message in a chat channel of the studio\'s private server, for example to tell a partner that a part is ready. The message is marked as sent by the user\'s assistant. Write in the studio\'s language (usually Arabic).',
    inputSchema: {
      type: 'object',
      properties: {
        studio_id: { type: 'string' },
        channel: { type: 'string', description: 'Channel id or name, e.g. general or a layer channel' },
        text: { type: 'string' }
      },
      required: ['studio_id', 'text'],
      additionalProperties: false
    },
    run: (user, a) => {
      const st = core.requireMember(user, a.studio_id);
      core.requireActive(st);
      const ch = core.studioChatChannel(st, a.channel);
      const m = core.postMessage(user, st.serverId, ch.id, a.text, { viaAI: true });
      return { posted: true, channel: ch.name, id: m.id };
    }
  },
  {
    name: 'cilyo_post_trial_link',
    description:
      'Share a link where partners can play the current version (for example a GitHub Pages URL) in the studio\'s trials channel. Only uploaded zip builds can be published to the store; links are for testing.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        url: { type: 'string' },
        note: { type: 'string', description: 'What changed in this version' }
      },
      required: ['project_id', 'url'],
      additionalProperties: false
    },
    run: (user, a) => core.addTrialLink(user, a.project_id, a.url, a.note, { viaAI: true })
  },
  {
    name: 'cilyo_decide_approval',
    description:
      'Approve or reject an open approval request that needs this user\'s decision. ONLY call this when the user explicitly tells you their decision in the conversation; never decide on your own.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string' },
        decision: { type: 'string', enum: ['yes', 'no'] }
      },
      required: ['approval_id', 'decision'],
      additionalProperties: false
    },
    run: (user, a) => core.decideApproval(user, a.approval_id, a.decision, { viaAI: true })
  }
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function handleOne(user, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const params = msg.params || {};
  let out;
  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      out = rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cilyo', version: '0.1.0' },
        instructions:
          'Cilyo is a shared game studio. Before coding, call cilyo_list_studios then cilyo_project_context. Only change code in layers the user owns; for anything another layer relies on, propose or update an agreement and let the partner approve it.'
      });
      break;
    }
    case 'ping':
      out = rpcResult(msg.id, {});
      break;
    case 'tools/list':
      out = rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      });
      break;
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        out = rpcError(msg.id, -32602, 'Unknown tool: ' + params.name);
        break;
      }
      try {
        const data = tool.run(user, params.arguments || {});
        out = rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        const text = err instanceof core.HttpError ? err.message : 'خطأ داخلي';
        if (!(err instanceof core.HttpError)) console.error(err);
        out = rpcResult(msg.id, { content: [{ type: 'text', text }], isError: true });
      }
      break;
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      out = rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
  }
  return isNotification ? null : out;
}

function mount(app) {
  app.post('/mcp', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const user = core.userByToken(token);
    if (!user) {
      return res.status(401).json(rpcError(null, -32001, 'رمز الموصل غلط أو ناقص. اعمل رمز جديد من إعدادات Cilyo.'));
    }
    const body = req.body;
    if (Array.isArray(body)) {
      const outs = body.map((m) => handleOne(user, m)).filter(Boolean);
      store.save();
      return outs.length ? res.json(outs) : res.status(202).end();
    }
    const out = handleOne(user, body);
    store.save();
    if (!out) return res.status(202).end();
    res.json(out);
  });
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
}

module.exports = { mount, TOOLS };
