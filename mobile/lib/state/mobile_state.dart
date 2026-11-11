import 'work_conversation_navigation.dart';
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';

import '../core/device_store.dart';
import '../core/cloud_conversation_request.dart';
import '../core/soduwork_api.dart';
import '../models/conversation_models.dart';
import '../models/work_models.dart';
import 'account_conversation_sync.dart';
import 'account_conversation_realtime.dart';
import 'team_message_inbox.dart';

enum MobilePhase {
  booting,
  disconnected,
  connecting,
  pendingActivation,
  ready,
  failed,
}

class MobileState extends ChangeNotifier {
  final DeviceStore store;
  final EndpointSettings? initialEndpoint;
  final bool endpointLocked;
  final String deviceDisplayName;
  late EndpointSettings endpoint;
  late SoduWorkApi api;

  MobilePhase phase = MobilePhase.booting;
  EnrollmentState? enrollment;
  String blockingError = '';
  String refreshError = '';
  bool syncing = false;
  bool signingOut = false;
  int? _accountAuthenticationScope;
  bool get authenticatingAccount =>
      phase == MobilePhase.connecting &&
      _accountAuthenticationScope == _scopeVersion;
  String signOutNotice = '';
  int tabIndex = 0;
  final workConversationNavigation = WorkConversationNavigation();
  DateTime? lastSyncedAt;

  final accountConversations = AccountConversationSync();
  final _accountRealtime = AccountConversationRealtime();
  final _accountConversationEvents = StreamController<void>.broadcast();
  Stream<void> get accountConversationEvents =>
      _accountConversationEvents.stream;
  late final teamMessages = TeamMessageInbox(
    load: ({required folder, required before}) =>
        api.teamMessages(folder: folder, before: before),
    read: (id) => api.readTeamMessage(id),
  )..addListener(notifyListeners);
  int? get unreadMessageCount => teamMessages.unreadCount;

  Future<void> loadTeamMessages() async {
    if (!_apiReady ||
        phase != MobilePhase.ready ||
        (enrollment?.ownerUserId ?? '').isEmpty) {
      return;
    }
    await teamMessages.refresh();
  }

  int get identityRevision => _scopeVersion;

  List<WorkTask> tasks = const [];
  List<ApprovalItem> pendingApprovals = const [];
  List<ApprovalItem> doneApprovals = const [];
  PersonalBrief? brief;
  AiRoster? _aiRoster;
  DateTime? _aiRosterLoadedAt;

  CloudConversationRequest? pendingCloudRequest;
  String pendingRequestError = '';
  String _restoredPendingScope = '';
  Future<void>? _pendingRestoreFuture;
  Future<void>? _refreshTask;
  Future<void> _requestMutation = Future.value();

  Future<void> _mutateCloudRequest(Future<void> Function() action) {
    final result = _requestMutation.then((_) => action());
    _requestMutation = result.catchError((Object _) {});
    return result;
  }

  Future<void> restorePendingBranch() {
    if (_pendingRestoreFuture != null) return _pendingRestoreFuture!;
    final scope = _scopeVersion;
    final operation = _mutateCloudRequest(() async {
      if (scope != _scopeVersion || _disposed) return;
      await _restorePendingBranch();
    });
    _pendingRestoreFuture = operation;
    operation.whenComplete(() {
      if (identical(_pendingRestoreFuture, operation)) {
        _pendingRestoreFuture = null;
      }
    });
    return operation;
  }

  Future<void> _restorePendingBranch() async {
    if (!_apiReady || phase != MobilePhase.ready || enrollment == null) return;
    final registered = enrollment!;
    final scope = _scopeVersion;
    final url = endpoint.baseUrl;
    final key = '$url:${registered.ownerUserId}:${registered.deviceId}';
    if (_restoredPendingScope == key) return;
    try {
      final saved = await store.readPendingBranch(
        url,
        registered.ownerUserId,
        registered.deviceId,
      );
      _checkIdentity(scope);
      if (saved != null) {
        final recovered = CloudConversationRequest.restoreCheckpoint(
          jsonDecode(saved) as Map<String, dynamic>,
        );
        if (pendingCloudRequest != null &&
            pendingCloudRequest!.id != recovered.id) {
          throw const FormatException('存在另一笔待核对请求。');
        }
        pendingCloudRequest ??= recovered;
      }
      pendingRequestError = '';
      _restoredPendingScope = key;
    } catch (_) {
      if (scope == _scopeVersion) {
        pendingRequestError = '上一次发送记录暂时无法读取，请重试恢复后再派发，避免重复执行。';
      }
    }
  }

  Future<void> rememberCloudRequest(CloudConversationRequest request) {
    final identity = _scopeVersion;
    return _mutateCloudRequest(() async {
      _checkIdentity(identity);
      await _restorePendingBranch();
      _checkIdentity(identity);
      if (pendingCloudRequest != null &&
          pendingCloudRequest!.id != request.id) {
        throw const ApiFailure('还有一笔派发结果待确认，请先核对原请求。', status: 409);
      }
      if (pendingRequestError.isNotEmpty) throw ApiFailure(pendingRequestError);
      if (_apiReady) {
        final scope = _scopeVersion;
        final registered = enrollment;
        if (registered == null || registered.ownerUserId.isEmpty) {
          throw const ApiFailure('请先登录。');
        }
        await store.writePendingBranch(
          endpoint.baseUrl,
          registered.ownerUserId,
          registered.deviceId,
          jsonEncode(request.checkpoint()),
        );
        _checkIdentity(scope);
      }
      pendingCloudRequest = request;
    });
  }

  Future<void> forgetCloudRequest(String expectedId) {
    final identity = _scopeVersion;
    return _mutateCloudRequest(() async {
      _checkIdentity(identity);
      if (pendingCloudRequest?.id != expectedId) return;
      final scope = _scopeVersion;
      final registered = enrollment;
      if (_apiReady && registered != null) {
        await store.writePendingBranch(
          endpoint.baseUrl,
          registered.ownerUserId,
          registered.deviceId,
          null,
        );
        _checkIdentity(scope);
      }
      pendingCloudRequest = null;
    });
  }

  /// Read the original server receipt only. Reopening the app never resends
  /// a payload whose acceptance is unknown, especially when attachments are gone.
  Future<Map<String, dynamic>> reconcilePendingCloudRequest() async {
    final identity = _scopeVersion;
    await restorePendingBranch();
    _checkIdentity(identity);
    if (pendingRequestError.isNotEmpty) throw ApiFailure(pendingRequestError);
    final request = pendingCloudRequest;
    if (request == null || request.isAccountBranch) {
      throw const ApiFailure('没有需要核对的普通会话请求。', status: 409);
    }
    final receipt = await api.cloudConversationReceipt(request.id);
    _checkIdentity(identity);
    if (pendingCloudRequest?.id != request.id) {
      throw const ApiFailure('待核对请求已变更，请重新打开当前会话。', status: 409);
    }
    _validateCloudReceipt(receipt, request);
    await forgetCloudRequest(request.id);
    _checkIdentity(identity);
    try {
      await loadConversations();
    } on ApiFailure catch (error) {
      _checkIdentity(identity);
      refreshError = error.message;
    }
    _checkIdentity(identity);
    notifyListeners();
    return receipt;
  }

  int _scopeVersion = 0;
  bool _apiReady = false;
  bool _disposed = false;

  MobileState({
    DeviceStore? store,
    this.initialEndpoint,
    this.endpointLocked = false,
    this.deviceDisplayName = 'SoduWork Mobile',
  }) : store = store ?? DeviceStore(),
       endpoint =
           initialEndpoint ??
           const EndpointSettings(
             environment: SoduWorkEnvironment.production,
             baseUrl: EndpointSettings.productionUrl,
           );

  Iterable<WorkTask> get requirementTasks =>
      tasks.where((task) => task.isRequirement);

  /// Approval task summaries may omit provenance; prefer the complete task
  /// identity when available without removing conversation approvals globally.
  List<ApprovalItem> get requirementApprovals {
    final byId = {for (final task in tasks) task.id: task};
    return pendingApprovals
        .where((item) {
          return item.task.isRequirement &&
              (byId[item.task.id]?.isRequirement ?? true);
        })
        .toList(growable: false);
  }

  int get openTaskCount => requirementTasks.where((task) => task.isOpen).length;
  int get runningCount =>
      requirementTasks.where((task) => task.isRunning).length;
  int get attentionCount =>
      requirementTasks.where((task) => task.needsAttention).length +
      requirementApprovals.length;

  List<WorkTask> get focusTasks {
    final rows = requirementTasks.where((task) => task.isOpen).toList()
      ..sort((a, b) {
        final attention =
            (b.needsAttention ? 1 : 0) - (a.needsAttention ? 1 : 0);
        if (attention != 0) return attention;
        final running = (b.isRunning ? 1 : 0) - (a.isRunning ? 1 : 0);
        if (running != 0) return running;
        return b.createdAt.compareTo(a.createdAt);
      });
    return rows.take(4).toList(growable: false);
  }

  Future<void> init({
    bool connectNow = true,
    bool restoreSavedSession = false,
  }) async {
    await store.init();
    endpoint = initialEndpoint ?? store.loadEndpoint();
    api = SoduWorkApi(
      store: store,
      endpoint: endpoint,
      deviceDisplayName: deviceDisplayName,
    );
    _apiReady = true;
    var restore = false;
    if (!connectNow && restoreSavedSession) {
      try {
        restore =
            !await store.isSignedOut(endpoint.baseUrl) &&
            (await store.readSession(endpoint.baseUrl))?.isNotEmpty == true;
      } catch (_) {
        // An unavailable browser store is not evidence of a valid session.
      }
    }
    if (_disposed) return;
    if (connectNow || restore) {
      await connect();
    } else {
      phase = MobilePhase.disconnected;
      notifyListeners();
    }
  }

  Future<void> connect() async {
    final scope = _scopeVersion;
    if (EndpointSettings.normalize(endpoint.baseUrl).isEmpty) {
      phase = MobilePhase.disconnected;
      blockingError = '';
      notifyListeners();
      return;
    }
    if (signingOut) return;
    if (await store.isSignedOut(endpoint.baseUrl)) {
      final credentials = await store.credentials(endpoint.baseUrl);
      if (scope != _scopeVersion || _disposed) return;
      enrollment = EnrollmentState(
        active: false,
        deviceId: credentials.id,
        deviceName: deviceDisplayName,
        authState: 'pending',
        ownerUserId: '',
      );
      phase = MobilePhase.pendingActivation;
      signOutNotice = await store.hasUncertainLogout(endpoint.baseUrl)
          ? '已退出此设备。远端旧设备注销尚未确认，需要时请联系管理员撤销旧设备。'
          : '已退出此设备，请重新登录。';
      if (scope != _scopeVersion || _disposed) return;
      notifyListeners();
      return;
    }
    if (scope != _scopeVersion || _disposed) return;
    phase = MobilePhase.connecting;
    blockingError = '';
    refreshError = '';
    notifyListeners();
    try {
      final result = await api.enroll();
      if (scope != _scopeVersion || _disposed) return;
      final previousOwner = enrollment?.ownerUserId ?? '';
      if (previousOwner.isNotEmpty &&
          (previousOwner != result.ownerUserId || !result.active)) {
        _stopAccountRealtime();
        _scopeVersion++;
        api.invalidateAuthentication();
        _clearRemoteData();
      }
      enrollment = result;
      if (enrollment!.active) {
        phase = MobilePhase.ready;
        _startAccountRealtime();
        notifyListeners();
        // The shell can render the conversation immediately. Initial task and approval sync stays in the background.
        await _refreshWithinBudget();
      } else {
        phase = MobilePhase.pendingActivation;
        notifyListeners();
      }
    } on ApiFailure catch (error) {
      if (scope != _scopeVersion || _disposed) return;
      blockingError = error.message;
      phase = MobilePhase.failed;
      notifyListeners();
    } catch (_) {
      if (scope != _scopeVersion || _disposed) return;
      blockingError = '$deviceDisplayName 未能完成初始化，请重试。';
      phase = MobilePhase.failed;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    if (signingOut) return;
    final registered = enrollment;
    _stopAccountRealtime();
    _scopeVersion++;
    final scope = _scopeVersion;
    signingOut = true;
    syncing = false;
    _clearRemoteData();
    tabIndex = 0;
    blockingError = '';
    refreshError = '';
    enrollment = registered == null
        ? null
        : EnrollmentState(
            active: false,
            deviceId: registered.deviceId,
            deviceName: registered.deviceName,
            authState: 'pending',
            ownerUserId: '',
          );
    phase = MobilePhase.pendingActivation;
    signOutNotice = '正在退出此设备…';
    final operation = api.signOut();
    notifyListeners();
    try {
      final result = await operation;
      if (scope != _scopeVersion || _disposed) return;
      signOutNotice = !result.storageConfirmed
          ? '已清除当前页面数据，但本机退出状态未能完整保存。请勿关闭页面；重试退出，或联系管理员撤销此设备。'
          : !result.remoteConfirmed
          ? '已退出此设备。远端旧设备注销尚未确认，需要时请联系管理员撤销旧设备。'
          : '已退出此设备，请重新登录。';
    } finally {
      if (scope == _scopeVersion && !_disposed) {
        signingOut = false;
        notifyListeners();
      }
    }
  }

  /// Account login during pending activation. On success the backend has
  /// activated this device, so the app transitions straight to ready.
  Future<void> loginWithAccount({
    required String account,
    required String password,
  }) => _authenticateAccount(
    () => api.loginWithAccount(account: account, password: password),
  );

  Future<ClientAuthPolicy> authenticationPolicy() => api.authenticationPolicy();

  Future<EmailAuthChallenge> requestEmailCode({
    required String email,
    required String purpose,
  }) {
    if (signingOut || phase == MobilePhase.ready) {
      throw const ApiFailure('请先退出当前账号，再进行邮箱验证。', status: 409);
    }
    return api.requestEmailCode(email: email, purpose: purpose);
  }

  Future<EmailCodeDelivery> emailCodeDelivery(EmailAuthChallenge challenge) =>
      api.emailCodeDelivery(challenge);

  Future<void> loginWithEmailPassword({
    required String email,
    required String password,
  }) => _authenticateAccount(
    () => api.loginWithEmailPassword(email: email, password: password),
  );

  Future<void> loginWithEmailCode({
    required EmailAuthChallenge challenge,
    required String code,
  }) => _authenticateAccount(
    () => api.loginWithEmailCode(challenge: challenge, code: code),
  );

  Future<void> registerWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String password,
    required Map<String, String> consents,
    String displayName = '',
  }) => _authenticateAccount(
    () => api.registerWithEmail(
      challenge: challenge,
      code: code,
      password: password,
      consents: consents,
      displayName: displayName,
    ),
  );

  Future<void> resetPasswordWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String newPassword,
  }) async {
    final scope = _scopeVersion;
    if (signingOut || phase == MobilePhase.ready) {
      throw const ApiFailure('请先退出当前账号，再找回密码。', status: 409);
    }
    await api.resetPasswordWithEmail(
      challenge: challenge,
      code: code,
      newPassword: newPassword,
    );
    _checkIdentity(scope);
  }

  Future<void> _authenticateAccount(
    Future<EnrollmentState> Function() authenticate,
  ) async {
    if (signingOut) throw const ApiFailure('正在完成退出，请稍后登录。', status: 409);
    final registeredDevice = enrollment;
    _stopAccountRealtime();
    _scopeVersion++;
    final scope = _scopeVersion;
    _accountAuthenticationScope = scope;
    _refreshTask = null;
    syncing = false;
    _clearRemoteData();
    if (registeredDevice != null) {
      enrollment = EnrollmentState(
        active: false,
        deviceId: registeredDevice.deviceId,
        deviceName: registeredDevice.deviceName,
        authState: 'pending',
        ownerUserId: '',
      );
    }
    phase = MobilePhase.connecting;
    blockingError = '';
    notifyListeners();
    try {
      final enrollment = await authenticate();
      if (scope != _scopeVersion || _disposed) return;
      this.enrollment = enrollment;
      signOutNotice = '';
      if (enrollment.active) {
        phase = MobilePhase.ready;
        _startAccountRealtime();
        notifyListeners();
        await _refreshWithinBudget();
      } else {
        phase = MobilePhase.pendingActivation;
        notifyListeners();
      }
    } on ApiFailure catch (error) {
      if (scope != _scopeVersion || _disposed) rethrow;
      blockingError = error.message;
      phase = MobilePhase.pendingActivation;
      notifyListeners();
      rethrow;
    } catch (_) {
      if (scope != _scopeVersion || _disposed) rethrow;
      blockingError = '$deviceDisplayName 未能完成登录，请重试。';
      phase = MobilePhase.pendingActivation;
      notifyListeners();
      rethrow;
    } finally {
      if (_accountAuthenticationScope == scope) {
        _accountAuthenticationScope = null;
      }
    }
  }

  Future<void> setEndpoint({
    required SoduWorkEnvironment environment,
    String developmentUrl = '',
  }) async {
    if (endpointLocked) {
      throw const ApiFailure('服务地址由企业应用统一管理。');
    }
    final next = EndpointSettings(
      environment: environment,
      baseUrl: environment == SoduWorkEnvironment.production
          ? EndpointSettings.normalize(EndpointSettings.productionUrl)
          : EndpointSettings.normalize(developmentUrl),
    );
    if (next.baseUrl.isEmpty) {
      throw const ApiFailure(
        '\u8bf7\u586b\u5199\u670d\u52a1\u5730\u5740\u3002',
      );
    }
    _stopAccountRealtime();
    _scopeVersion++;
    _refreshTask = null;
    syncing = false;
    endpoint = next;
    api.setEndpoint(next);
    _clearRemoteData();
    phase = MobilePhase.connecting;
    notifyListeners();
    await store.saveEndpoint(next);
    await connect();
  }

  Future<void> _refreshWithinBudget() async {
    try {
      await Future.any<void>([
        refreshAll(),
        Future<void>.delayed(const Duration(milliseconds: 300)),
      ]);
    } catch (_) {
      // The shell is already usable; refreshAll records API failures itself.
    }
  }

  Future<void> refreshAll() {
    if (!_apiReady || phase != MobilePhase.ready) return Future.value();
    final active = _refreshTask;
    if (active != null) return active;
    final operation = _refreshAll();
    _refreshTask = operation;
    operation.whenComplete(() {
      if (identical(_refreshTask, operation)) _refreshTask = null;
    });
    return operation;
  }

  Future<void> _refreshAll() async {
    if (syncing) return;
    final scope = _scopeVersion;
    syncing = true;
    await restorePendingBranch();
    if (scope != _scopeVersion || _disposed) {
      syncing = false;
      return;
    }
    refreshError = '';
    notifyListeners();
    try {
      final essentials = await Future.wait<dynamic>([
        api.tasks(),
        api.approvals(view: 'pending'),
        api.approvals(view: 'done'),
      ]);
      if (scope != _scopeVersion || _disposed) return;
      tasks = essentials[0] as List<WorkTask>;
      pendingApprovals = essentials[1] as List<ApprovalItem>;
      doneApprovals = essentials[2] as List<ApprovalItem>;
      lastSyncedAt = DateTime.now();
    } on ApiFailure catch (error) {
      if (scope != _scopeVersion || _disposed) return;
      refreshError = error.message;
      if (error.needsActivation) {
        phase = MobilePhase.pendingActivation;
      }
    } finally {
      if (scope == _scopeVersion && !_disposed) {
        syncing = false;
        notifyListeners();
      }
    }
  }

  void selectTab(int index) {
    if (index == tabIndex) return;
    tabIndex = index.clamp(0, 3);
    notifyListeners();
  }

  Future<Map<String, dynamic>> parseTask(String text) => api.parseTask(text);

  // -----------------------------------------------------------------------
  // Cloud conversations (mobile-initiated, cloud-executed AI sessions)
  // -----------------------------------------------------------------------

  List<CloudConversation> get conversations {
    final rows = [
      for (final task in tasks)
        if (task.origin == 'cloud-conversation')
          CloudConversation.fromJson({
            'id': task.id,
            'title': task.title,
            'status': task.status,
            'created': task.createdAt,
            'origin': task.origin,
            'createdByName': task.createdByName,
            'ai': {'state': task.aiState, 'name': task.aiName},
          }),
    ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return rows;
  }

  int get runningConversationCount =>
      conversations.where((item) => item.running).length;

  void _startAccountRealtime() {
    if (!_apiReady || phase != MobilePhase.ready || enrollment == null) return;
    final scope = _scopeVersion;
    final deviceId = enrollment!.deviceId;
    unawaited(
      _accountRealtime.start(
        baseUrl: Uri.parse(endpoint.baseUrl),
        deviceId: deviceId,
        session: api.realtimeSession,
        isCurrent: () =>
            !_disposed &&
            scope == _scopeVersion &&
            phase == MobilePhase.ready &&
            enrollment?.deviceId == deviceId,
        onEvent: () {
          if (_disposed || scope != _scopeVersion) return;
          unawaited(() async {
            await loadAccountConversations();
            if (!_disposed && scope == _scopeVersion) {
              _accountConversationEvents.add(null);
            }
          }());
        },
      ),
    );
  }

  void _stopAccountRealtime() {
    unawaited(_accountRealtime.stop());
  }

  Future<void> loadAccountConversations() async {
    if (!_apiReady ||
        phase != MobilePhase.ready ||
        (enrollment?.ownerUserId ?? '').isEmpty) {
      return;
    }
    final scope = _scopeVersion;
    final future = accountConversations.refresh(
      load: api.accountConversations,
      isCurrent: () =>
          scope == _scopeVersion && !_disposed && phase == MobilePhase.ready,
    );
    notifyListeners();
    await future;
    if (scope == _scopeVersion && !_disposed) notifyListeners();
  }

  Future<List<CloudConversation>> loadConversations() async {
    final scope = _scopeVersion;
    final rows = (await api.cloudConversations())
        .map(CloudConversation.fromJson)
        .toList(growable: false);
    if (scope != _scopeVersion || _disposed) return const [];
    final others = tasks
        .where((item) => item.origin != 'cloud-conversation')
        .toList(growable: false);
    tasks = [...rows.map((item) => item.task), ...others];
    notifyListeners();
    return rows;
  }

  // Both initial submission and recovery require the same durable acceptance.
  void _validateCloudReceipt(
    Map<String, dynamic> receipt,
    CloudConversationRequest request,
  ) {
    final source = receipt['source'];
    if (receipt['ok'] != true ||
        receipt['transferId'] != request.id ||
        source is! Map ||
        source['entryKind'] != 'cloud' ||
        source['sessionId'] != request.options['sessionId'] ||
        source['adapterId'] != request.options['agentId']) {
      throw const ApiFailure('回执与原请求不一致，请保留记录并重试核对。', isNetwork: true);
    }
    if (receipt['phase'] != 'committed' ||
        (receipt['taskId'] is! String ||
            (receipt['taskId'] as String).isEmpty) ||
        (receipt['ref'] is! String || (receipt['ref'] as String).isEmpty)) {
      throw const ApiFailure('尚未确认云端接单，请稍后再次核对，避免重复发送。', isNetwork: true);
    }
  }

  Future<Map<String, dynamic>> startCloudConversation({
    required String text,
    String agentId = '',
    String model = '',
    String title = '',
    List<XFile> files = const [],
    CloudConversationRequest? request,
  }) async {
    if (request?.receiptOnly == true) {
      throw const ApiFailure('上次发送结果待确认，请先核对原请求，避免重复执行。', status: 409);
    }
    final scope = _scopeVersion;
    final receipt = await api.createCloudConversation(
      text: text,
      agentId: agentId,
      model: model,
      title: title,
      files: files,
      request: request,
    );
    if (scope != _scopeVersion || _disposed) {
      throw const ApiFailure('服务地址已切换，请在原服务核对派发结果。');
    }
    if (request?.isAccountBranch == true) {
      final branch = receipt['branch'];
      if (receipt['transferId'] != request!.id ||
          receipt['sessionId'] != 'cloud-${request.id}' ||
          branch is! Map ||
          branch['accountConversationId'] !=
              request.options['accountConversationId'] ||
          branch['expectedRevision'] != request.options['expectedRevision']) {
        throw const ApiFailure('接单回执与本次续聊不一致，请保留原请求重试核对。', isNetwork: true);
      }
    }
    if (request != null && !request.isAccountBranch) {
      _validateCloudReceipt(receipt, request);
    }
    if (receipt['phase'] == 'aborted') {
      throw const ApiFailure('本次派发已取消，请重新提交。', status: 409);
    }
    if (receipt['ok'] != true || (receipt['taskId'] ?? '').toString().isEmpty) {
      throw const ApiFailure('未收到明确接单回执，请重试核对同一次派发。', isNetwork: true);
    }
    if (request?.isAccountBranch == true &&
        (receipt['phase'] != 'committed' ||
            (receipt['ref'] ?? '').toString().isEmpty)) {
      throw const ApiFailure('云端正在确认接单，请用同一次请求重试核对。', isNetwork: true);
    }
    if (request != null) await forgetCloudRequest(request.id);
    try {
      await loadConversations();
    } on ApiFailure catch (error) {
      if (scope == _scopeVersion && !_disposed) {
        refreshError = error.message;
        notifyListeners();
      }
    }
    if (scope != _scopeVersion || _disposed) {
      throw const ApiFailure('服务地址已切换，请在原服务核对派发结果。');
    }
    return receipt;
  }

  Future<Map<String, dynamic>> loadConversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) => api.conversationSession(taskId, ref: ref, since: since);

  Future<Map<String, dynamic>> sayToConversation(
    String taskId, {
    required String text,
    required String messageId,
    Map<String, String>? executionSelection,
  }) => api.sayToConversation(
    taskId,
    text: text,
    messageId: messageId,
    executionSelection: executionSelection,
  );

  Future<Map<String, dynamic>> stopConversation(String taskId) =>
      api.stopConversation(taskId);

  Future<Map<String, dynamic>> loadConversationDelivery(String taskId) =>
      api.taskDelivery(taskId);

  Future<List<ConversationAttachment>> loadConversationAttachments(
    String taskId,
  ) async {
    final rows = await api.taskAttachments(taskId);
    return rows.map(ConversationAttachment.fromJson).toList(growable: false);
  }

  Future<Map<String, dynamic>> cloudConversationTargets() =>
      api.cloudConversationTargets();

  Future<AiRoster> aiAgents({bool force = false}) async {
    final cached = _aiRoster;
    final loadedAt = _aiRosterLoadedAt;
    if (!force &&
        cached != null &&
        loadedAt != null &&
        DateTime.now().difference(loadedAt) < const Duration(seconds: 8)) {
      return cached;
    }
    final scope = _scopeVersion;
    final roster = await api.aiAgents();
    if (scope != _scopeVersion || _disposed) {
      throw const ApiFailure('服务地址已切换，请刷新执行底座列表。');
    }
    _aiRoster = roster;
    _aiRosterLoadedAt = DateTime.now();
    return roster;
  }

  Future<WorkTask> dispatchTaskToAi(
    WorkTask task, {
    required AiAssignee assignee,
    String brief = '',
  }) async {
    final identity = _scopeVersion;
    final updated = await api.dispatchTaskToAi(
      task.id,
      assignee: assignee,
      brief: brief,
    );
    _checkIdentity(identity);
    _aiRosterLoadedAt = null;
    _replaceTask(updated);
    return updated;
  }

  Future<AiExecutionStatus> loadAiStatus(String taskId) => api.aiStatus(taskId);

  Future<List<AutomationSchedule>> loadAutomations() => api.automations();

  Future<List<AutomationRun>> loadAutomationRuns(String scheduleId) =>
      api.automationRuns(scheduleId);

  Future<AutomationSchedule> setAutomationEnabled(
    AutomationSchedule schedule,
    bool enabled,
  ) => api.setAutomationEnabled(schedule.id, enabled);

  Future<Map<String, dynamic>> runAutomation(AutomationSchedule schedule) =>
      api.runAutomation(schedule.id);

  WorkTask? findTask(String taskId) {
    for (final task in tasks) {
      if (task.id == taskId) return task;
    }
    return null;
  }

  /// Applies an authenticated Hub receipt, never a local compose draft.
  void applyRequirementReceipt(Map<String, dynamic> receipt) {
    _replaceTask(WorkTask.fromJson(receipt));
  }

  Future<WorkTask> loadTask(String id) async {
    final identity = _scopeVersion;
    final task = await api.task(id);
    _checkIdentity(identity);
    _replaceTask(task);
    return task;
  }

  Future<WorkTask> createTask({
    required String title,
    String note = '',
    String priority = 'normal',
    String handler = 'me',
    String kind = 'requirement',
    String visibility = 'related',
    String triageStage = 'intake',
    List<String> acceptanceCriteria = const <String>[],
    List<String> tags = const <String>[],
    DateTime? start,
    DateTime? due,
  }) async {
    final identity = _scopeVersion;
    final now = DateTime.now();
    final startDate = start ?? DateTime(now.year, now.month, now.day);
    final dueDate = due ?? DateTime(now.year, now.month, now.day, 23, 59, 59);
    final task = await api.createTask({
      'title': title.trim(),
      'note': note.trim(),
      'source': deviceDisplayName,
      'status': 'todo',
      'priority': priority,
      'handler': handler,
      'kind': kind,
      'visibility': visibility,
      'triageStage': triageStage,
      'acceptanceCriteria': acceptanceCriteria,
      'tags': tags,
      'start': startDate.millisecondsSinceEpoch,
      'due': dueDate.millisecondsSinceEpoch,
    });
    _checkIdentity(identity);
    tasks = [task, ...tasks.where((item) => item.id != task.id)];
    notifyListeners();
    return task;
  }

  Future<void> setTaskStatus(WorkTask task, String status) async {
    final identity = _scopeVersion;
    final updated = await api.patchTask(task.id, {'status': status});
    _checkIdentity(identity);
    _replaceTask(updated);
  }

  Future<void> addProgress(WorkTask task, String text) async {
    final value = text.trim();
    if (value.isEmpty) return;
    final progress = [
      ...task.progress,
      {
        'text': value,
        'at': DateTime.now().millisecondsSinceEpoch,
        'source': 'mobile',
      },
    ];
    final identity = _scopeVersion;
    final updated = await api.patchTask(task.id, {'progress': progress});
    _checkIdentity(identity);
    _replaceTask(updated);
  }

  Future<Map<String, dynamic>> loadTaskTrace(String taskId) =>
      api.taskTrace(taskId);

  Future<List<Map<String, dynamic>>> loadTaskEvents(String taskId) =>
      api.taskEvents(taskId);

  Future<Map<String, dynamic>> loadApprovalDetail(String approvalId) =>
      api.approvalDetail(approvalId);

  Future<void> decideApproval(
    ApprovalItem item, {
    required String decision,
    String note = '',
  }) async {
    await api.decideApproval(item.id, decision: decision, note: note);
    await refreshAll();
  }

  Future<void> uploadEvidence(ApprovalItem item, XFile file) async {
    await api.uploadApprovalEvidence(item.id, file);
    notifyListeners();
  }

  Future<void> generateBrief() async {
    final identity = _scopeVersion;
    await api.generateBrief();
    _checkIdentity(identity);
    final result = await api.personalBrief();
    _checkIdentity(identity);
    brief = result;
    notifyListeners();
  }

  Future<List<Map<String, dynamic>>> teammates() => api.teammates();

  Future<void> handoffTask(
    WorkTask task, {
    required String assigneeUserId,
    String note = '',
  }) async {
    await api.handoffTask(task.id, assigneeUserId: assigneeUserId, note: note);
    await refreshAll();
  }

  void _checkIdentity(int identity) {
    if (identity != _scopeVersion || _disposed) {
      throw const ApiFailure('账号已切换，本次操作结果未应用。', status: 409);
    }
  }

  void _replaceTask(WorkTask task) {
    final exists = tasks.any((item) => item.id == task.id);
    tasks = exists
        ? tasks
              .map((item) => item.id == task.id ? task : item)
              .toList(growable: false)
        : [task, ...tasks];
    notifyListeners();
  }

  void _clearRemoteData() {
    workConversationNavigation.clear();
    accountConversations.clear();
    teamMessages.clear();
    pendingCloudRequest = null;
    pendingRequestError = '';
    _restoredPendingScope = '';
    _pendingRestoreFuture = null;
    tasks = const [];
    pendingApprovals = const [];
    doneApprovals = const [];
    brief = null;
    _aiRoster = null;
    _aiRosterLoadedAt = null;
    enrollment = null;
    lastSyncedAt = null;
  }

  @override
  void notifyListeners() {
    if (_disposed) return;
    super.notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _stopAccountRealtime();
    _accountConversationEvents.close();
    accountConversations.clear();
    teamMessages.dispose();
    workConversationNavigation.dispose();
    if (_apiReady) api.client.close();
    super.dispose();
  }
}
