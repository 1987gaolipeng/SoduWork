import '../models/work_models.dart';

const cloudConversationReadOnlyReason =
    '当前设备仅可查看此会话，暂不能继续发送。请在创建会话的设备继续，或新建云会话。已有记录和成果仍可查看，未发送内容可复制保留。';

/// Session capabilities override the conservative legacy cloud-task hint.
/// Matching task ownership alone must never grant execution permission.
Map<String, dynamic> cloudConversationAccess(
  WorkTask? task,
  Map<String, dynamic> session,
) {
  if (session['canSend'] is bool) {
    return {
      'canSend': session['canSend'],
      if (session['canSend'] == false)
        'readOnlyReason': session['mobileAcceptance'] is Map
            ? '自动验收会话保留本轮报告；请回到原需求查看结果或重新发起验收。'
            : cloudConversationReadOnlyReason,
    };
  }
  if (task?.origin == 'cloud-conversation' && task?.canSend == true) {
    return {'canSend': true};
  }
  if (task?.origin == 'cloud-conversation' && task?.readOnly == true) {
    return {
      'canSend': false,
      'readOnlyReason': cloudConversationReadOnlyReason,
    };
  }
  return {};
}
