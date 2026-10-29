/* Explicit synthetic responses for the complete production desk page. */
(function (global) {
  'use strict';
  global.fixtureErrors = [];
  global.fixtureCalls = [];
  global.fixtureFailures = new Set();
  global.fixtureOverrides = Object.create(null);
  addEventListener('error', e => fixtureErrors.push(e.message));
  addEventListener('unhandledrejection', e => fixtureErrors.push(String(e.reason)));
  global.fixtureTasks = [];
  global.fixtureOwner = 'page-audit-owner';
  const plain = value => structuredClone(value);
  const rows = {
    myModels: {providers: [], myModels: [], usable: []},
    myGit: {git: {name: 'Fixture Author', email: 'fixture@example.test'}, repos: []},
    agentSetup: {env: {}, agents: [], modelCount: 0, runners: []},
    runners: {runners: []},
    pluginCatalog: {items: []},
    personalPlugins: {items: []},
    capabilityCatalog: {skills: [], mcpTemplates: [], summary: {}},
    myMcpServers: {company: [], personal: [], enabledCompany: []},
    getCloudEnvironments: {environments: [], permissions: {canCreate: true}},
    listCloudEnvironments: {environments: [], permissions: {canCreate: true}},
    cloudEnvironments: {environments: [], permissions: {canCreate: true}},
    listLibrary: {items: [], folders: [], total: 0},
    getLibraryStorageStatus: {local: {available: true}, minio: {configured: true, available: true}},
    getTeamCapability: {canManage: true, teamModuleVisible: true, assigned: true, meId: 'fixture-user', meName: 'Fixture User'},
    getTeam: {members: [], canManage: true, organizations: [], orgs: []},
    getTeamTasks: {tasks: [], members: []},
    getTeamInbox: {items: []},
    getProjects: [], getTasks: [], listRepos: [], listTeammates: [],
    listSchedules: [], listScheduleTemplates: [], listScheduleRuns: [],
    mateMessages: {items: []},
    pluginAudienceCandidates: {users: [], teams: []},
    teamMates: [], myUsage: {days: 30, summary: {}, bySource: [], byAgent: [], trend: [], recent: [], quality: {}},
    getWorkReports: {period: {label: 'Today', isCurrent: true}, capability: {canManage: true}, personal: {hasMaterial: false}, team: {}},
    getConfig: {}, getAiDesks: {desks: [], tasks: []}, aiDesks: {desks: [], tasks: []},
  };
  global.fixtureData = rows;
  global.fixtureApiCall = async (key, ...args) => {
    fixtureCalls.push({key, args});
    if (fixtureFailures.has(key)) throw Error('Synthetic API unavailable: ' + key);
    if (fixtureOverrides[key]) return fixtureOverrides[key](...args);
    if (key === 'getTasks') return plain(fixtureTasks);
    if (key === 'getTask') return plain(fixtureTasks.find(t => t.id === args[0]) || null);
    if (key in rows) return plain(rows[key]);
    return {ok: true, items: [], skills: [], enabled: [], schedules: [], runs: [], agents: [], desks: []};
  };
  global.fixtureInstallApi = () => {
    global.SoduWorkAPI = new Proxy({
      online: true, clientId: 'fixture-device',
      taskStorageKey: () => fixtureOwner,
      clientAuthSnapshot: () => ({state: 'active'}),
    }, {get: (target, key) => key in target ? target[key] : (...args) => fixtureApiCall(key, ...args)});
    global.initData = async () => {
      tasks = fixtureTasks; Store._tasks = fixtureTasks; Store._taskState = 'ready';
      Store._startupPromise = Promise.resolve();
      dispatchEvent(new CustomEvent('soduwork-device-auth', {detail: {state: 'active', user: {id: 'fixture-user'}}}));
    };
    global.__teamCap = plain(rows.getTeamCapability);
    addEventListener('soduwork-workspace-ready', () => {global.fixtureReady = true;});
  };
  const noop = () => {};
  const empty = async () => ({ok: true, items: [], chats: [], runtimes: [], capabilities: [], files: []});
  const bridge = {
    conversationSession: {history: empty, archivedHistory: empty, runtimes: empty, probe: empty,
      capabilities: empty, onEvent: () => noop, onPresence: () => noop, onProgress: () => noop,
      outputs: empty, pickCwd: async () => ({ok: true, dir: 'D:/isolated/page-audit', name: 'Fixture'}),
      open: async () => ({ok: false, reason: 'Execution excluded from page audit'}), release: empty},
    sessionMemory: new Proxy({}, {get: () => empty}),
    memoryDimensions: new Proxy({}, {get: key => key === 'get' ? async () => ({ok: true, item: null}) : empty}),
    personalPlugins: {list: empty, onChanged: () => noop},
    platformConnections: {status: empty, onPending: () => noop, onChanged: () => noop},
    workPreview: {destroy: empty, occlude: empty, onNavigate: () => noop, onNavigation: () => noop},
    fileOpen: {list: empty, ack: empty, onPending: () => noop},
    recentWorkspace: {get: empty},
    accessPreferences: {get: async () => ({ok: true, mode: 'standard'}), onChanged: () => noop},
    getDefaultWorkRoot: async () => 'D:/isolated/page-audit',
    deviceAuthBootstrap: async () => ({ok: true, user: {id: 'fixture-user'}}),
    hubConnectionInfo: async () => ({hub: 'http://127.0.0.1:19999', internalTest: true, editable: false}),
    clientUpdateStatus: async () => ({state: 'development', currentVersion: '1.12.78'}),
    broadcast: noop,
  };
  bridge.conversationSession.memory = {dimensions: bridge.memoryDimensions, options: empty, preview: empty, list: empty};
  global.soduWorkAPI = new Proxy(bridge, {get: (target, key) => key in target ? target[key] :
    /^on[A-Z]/.test(key) ? () => noop : empty});
})(window);
