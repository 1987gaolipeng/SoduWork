import 'mobile_work_translations.dart';
import 'package:flutter/material.dart';
import '../core/mobile_preferences.dart';
import '../sdk/soduwork_brand.dart';
import 'mobile_appearance.dart';
import 'mobile_theme.dart';

enum MobileAppearanceMode { system, light, dark }

enum MobileLanguage { chinese, english }

class MobileDisplayPreferences extends ChangeNotifier {
  final bool persist;
  MobileAppearanceMode appearance = MobileAppearanceMode.system;
  MobileLanguage language = MobileLanguage.chinese;
  String accent = 'brand';
  String saveError = '';
  int _revision = 0;
  bool _closed = false;
  Future<void> _writes = Future.value();
  MobileDisplayPreferences({this.persist = true});

  Future<void> restore() async {
    if (!persist) return;
    final revision = _revision;
    try {
      final values = await MobilePreferences.presentation();
      if (_closed || revision != _revision) return;
      appearance = MobileAppearanceMode.values.firstWhere(
        (v) => v.name == values['appearance'],
        orElse: () => MobileAppearanceMode.system,
      );
      language = values['language'] == 'english'
          ? MobileLanguage.english
          : MobileLanguage.chinese;
      accent =
          const ['brand', 'neutral', 'blue', 'green'].contains(values['accent'])
          ? values['accent']!
          : 'brand';
      notifyListeners();
    } catch (_) {
      /* Presentation remains usable when local storage is unavailable. */
    }
  }

  Future<void> update({
    MobileAppearanceMode? appearance,
    MobileLanguage? language,
    String? accent,
  }) {
    if (_closed) return Future.value();
    this.appearance = appearance ?? this.appearance;
    this.language = language ?? this.language;
    if (accent != null &&
        const ['brand', 'neutral', 'blue', 'green'].contains(accent)) {
      this.accent = accent;
    }
    _revision++;
    saveError = '';
    notifyListeners();
    if (!persist) return Future.value();
    final snapshot = {
      'appearance': this.appearance.name,
      'language': this.language.name,
      'accent': this.accent,
    };
    final saveRevision = _revision;
    _writes = _writes.then((_) async {
      try {
        await MobilePreferences.savePresentation(snapshot);
      } catch (_) {
        if (!_closed && saveRevision == _revision) {
          saveError = '偏好已应用，本机保存暂未完成。';
          notifyListeners();
        }
      }
    });
    return _writes;
  }

  SoduWorkBrandTheme apply(SoduWorkBrandTheme base, Brightness platform) {
    final brightness = switch (appearance) {
      MobileAppearanceMode.system => platform,
      MobileAppearanceMode.light => Brightness.light,
      MobileAppearanceMode.dark => Brightness.dark,
    };
    final result = mobileAppearance(base, brightness);
    final primary = switch (accent) {
      'brand' =>
        brightness == Brightness.dark &&
                base.primary == const SoduWorkBrandTheme().primary
            ? const Color(0xFFBFA3EA)
            : base.primary,
      'blue' =>
        brightness == Brightness.dark
            ? const Color(0xFF9EBFFF)
            : const Color(0xFF3478F6),
      'green' =>
        brightness == Brightness.dark
            ? const Color(0xFF86D7B9)
            : const Color(0xFF168363),
      _ => result.ink,
    };
    return result.copyWith(
      primary: primary,
      primarySoft: Color.alphaBlend(
        primary.withValues(alpha: 0.10),
        result.surface,
      ),
    );
  }

  String text(String chinese) => language == MobileLanguage.english
      ? (_english[chinese] ?? mobileWorkEnglish[chinese] ?? chinese)
      : chinese;
  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class MobileDisplayScope extends InheritedNotifier<MobileDisplayPreferences> {
  const MobileDisplayScope({
    super.key,
    required MobileDisplayPreferences preferences,
    required super.child,
  }) : super(notifier: preferences);
  static MobileDisplayPreferences? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<MobileDisplayScope>()
      ?.notifier;
}

String mobileText(
  BuildContext context,
  String value, {
  List<Object?> values = const [],
}) {
  final translated = MobileDisplayScope.maybeOf(context)?.text(value) ?? value;
  // Substitute only known template slots after lookup. Values remain verbatim.
  return translated.replaceAllMapped(RegExp(r'\{(\d+)\}'), (match) {
    final index = int.parse(match[1]!);
    return index < values.length
        ? (values[index]?.toString() ?? '')
        : match[0]!;
  });
}

const _english = <String, String>{
  '切换账号': 'Switch account',
  '通知': 'Notifications',
  '我的': 'Profile',
  '账号、设备与个人设置': 'Account, device and preferences',
  '同步中': 'Syncing',
  '更新失败': 'Update failed',
  '已登录': 'Signed in',
  '查看当前账号授权的模型': 'Models available to your account',
  '我的自动化': 'My automations',
  '查看计划、运行记录和失败恢复': 'Schedules, run history and recovery',
  '同事留言、工作交办与已读回执': 'Team messages, assignments and receipts',
  '开发预览': 'Development preview',
  '团队试用版': 'Team preview',
  '暂不支持': 'Not supported yet',
  '账号已变化，请关闭后重新打开。': 'Your account changed. Close and reopen this panel.',
  '此设备将退出登录。已同步的会话仍保留在企业工作空间中。':
      'This device will be signed out. Synced conversations remain in your workspace.',
  '企业团队的移动 AI 工作空间。正式发行版本与隐私说明将在发布前提供。':
      'A mobile AI workspace for teams. Release and privacy information will be available before launch.',
  '英文已覆盖导航与设置，部分工作界面仍显示中文。工作内容保持原文。':
      'Navigation and settings support English. Some work screens remain in Chinese. Your content stays in its original language.',
  '更多': 'More',
  '主页': 'Home',
  '需求池': 'Requests',
  '插件': 'Plugins',
  '简报': 'Brief',
  '我的模型': 'My models',
  '云端环境': 'Cloud environments',
  '工作简报': 'Work brief',
  '会话选项': 'Conversation options',
  '聊天': 'Chat',
  '工作': 'Work',
  '设置': 'Settings',
  '关闭': 'Close',
  '搜索会话': 'Search',
  '工作与审批': 'Work & approvals',
  '插件与工具': 'Tools',
  '模型': 'Models',
  '自动化': 'Automations',
  '远程': 'Remote',
  '最近': 'Recent',
  '已归档': 'Archived',
  '同步电脑会话': 'Sync conversations',
  '返回最近': 'Recent',
  '加载更多会话': 'Load more',
  '从一个问题开始吧。': 'Start with a question.',
  '没有找到匹配的会话': 'No conversations found',
  '暂无已归档会话': 'No archived conversations',
  '我的工作空间': 'Settings',
  '项目': 'Projects',
  '管理记忆': 'Manage memories',
  '个性化': 'Personalization',
  '打开侧栏': 'Open sidebar',
  '新会话': 'New chat',
  '新工作': 'New work',
  '新对话': 'New conversation',
  '当前对话': 'Current conversation',
  '工作对话': 'Work conversation',
  '会话': 'Conversations',
  '任务': 'Tasks',
  '搜索工作会话': 'Search work conversations',
  '试试其他关键词，或开始新的工作。': 'Try another keyword or start new work.',
  '外观': 'Appearance',
  '账号详情': 'Account details',
  '设备标识': 'Device ID',
  '团队标识': 'Team ID',
  '角色标识': 'Role ID',
  '账号': 'Account',
  '显示名称': 'Display name',
  '用户标识': 'User ID',
  '企业服务': 'Workspace',
  '当前设备': 'This device',
  '主题': 'Theme',
  '语言': 'Language',
  '强调色': 'Accent color',
  '跟随系统': 'System',
  '浅色': 'Light',
  '深色': 'Dark',
  '黑白': 'Neutral',
  '蓝色': 'Blue',
  '绿色': 'Green',
  '简体中文': '简体中文',
  '英语': 'English',
  '账户信息': 'Account information',
  '使用情况': 'Usage',
  '本月已用': 'Used this month',
  '本月额度': 'Monthly limit',
  '偏好设置': 'Preferences',
  '工作空间': 'Workspace',
  '消息通知': 'Notifications',
  '模型与执行环境': 'Models & environments',
  '连接与设备': 'Connection & device',
  '关于': 'About',
  '退出当前账号': 'Sign out',
  '正在退出…': 'Signing out…',
  '退出当前账号？': 'Sign out?',
  '取消': 'Cancel',
  '退出账号': 'Sign out',
  '重新读取': 'Retry',
  '重试': 'Retry',
  '账号资料暂时无法读取': 'Account information is unavailable',
  '界面预览': 'Interface preview',
  '未提供': 'Not provided',
  '偏好已应用，本机保存暂未完成。': 'Preferences applied. Local saving is unavailable.',
  '搜索聊天和工作': 'Search chats and work',
  '全部': 'All',
  '搜索': 'Search',
  '清空搜索': 'Clear search',
  '无结果': 'No results',
  '试试其他关键词，或开始新的聊天。': 'Try another keyword or start a new chat.',
  '新聊天': 'New chat',
  '当前匹配已同步的标题与工作摘要': 'Searches synced titles and work summaries',
  '电脑会话': 'Desktop conversation',
  '有问题，尽管问': 'Ask anything',
  '与 SoduWork 协作': 'Work with SoduWork',
  '继续聊聊…': 'Message SoduWork',
  '选择模型': 'Model',
  '插件预设': 'Tool preset',
  '同事留言': 'Message',
  '发送': 'Send',
  '语音输入': 'Dictate',
  '添加材料与执行方式': 'Add files and tools',
  '解释一个概念': 'Explain a concept',
  '帮我润色文字': 'Write or edit',
  '一起理清思路': 'Explore an idea',
  '整理一份工作简报': 'Prepare a work brief',
  '分析文档与资料': 'Analyze documents',
  '开始一项工作': 'Start a task',
  '今天，想聊些什么？': 'What can I help with?',
  '想把什么交给我？': 'What shall we work on?',
  '重要的决定，请核对依据与结果。': 'Check important information.',
  '仅供界面体验，不会调用模型或连接企业服务': 'Interface preview only. No AI requests.',
  '工作模型': 'Work model',
  '聊天模型': 'Chat model',
  '环境默认模型': 'Environment default',
  '模型设置与连接': 'Model settings',
  '收到的': 'Inbox',
  '已发送': 'Sent',
  '刷新消息': 'Refresh',
  '团队的消息，随时接续。': 'Keep in touch with your team.',
  '与电脑同步你的私有收件箱': 'Your private inbox, synced with desktop',
  '加载更早消息': 'Load earlier messages',
  '正在获取消息…': 'Loading messages…',
  '还没有发出的消息': 'No sent messages',
  '暂时没有消息': 'No messages yet',
  '同事留言和工作交办会保存在这里。': 'Team messages and assignments appear here.',
  '消息详情': 'Message',
  '复制消息': 'Copy message',
  '查看关联工作': 'Open related work',
  '消息已关闭，请返回后刷新。': 'This message is no longer available.',
};

Color mobileActionColor(BuildContext context) {
  final accent = MobileDisplayScope.maybeOf(context)?.accent;
  return accent == 'brand' || accent == 'blue' || accent == 'green'
      ? context.soduWorkTheme.primary
      : context.soduWorkTheme.ink;
}
