export default {
  '{0}的模型列表': 'Models for {0}',
  '模型列表已收起，点击展开查看配置': 'Model list collapsed. Expand it to view configuration.',
  '组织默认调用': 'Organization defaults',
  '对话模型': 'Chat model', '模型用途': 'Model purpose', '模型能力': 'Model capabilities',
  '图片输入': 'Image input', '工具调用': 'Tool calling', '流式输出': 'Streaming',
  '未确认': 'Unknown', '支持': 'Supported', '不支持': 'Unsupported',
  '手动配置': 'Manual configuration', '已有配置': 'Existing configuration', '实际检测': 'Verified by test',
  '检测通过': 'Passed', '检测失败': 'Failed', '未能确认': 'Inconclusive',
  '能力尚未检测': 'Capabilities not tested', '检测结果': 'Test results', '服务连接': 'Connection',
  '服务响应超时，可稍后重试': 'The provider timed out. Try again later.',
  '服务暂时不可用，可稍后重试': 'The provider is temporarily unavailable. Try again later.',
  '请检查凭据及模型访问权限': 'Check credentials and model access.',
  '请检查模型 ID 和接口地址': 'Check the model ID and endpoint.',
  '服务明确返回不支持此能力': 'The provider explicitly reported this capability as unsupported.',
  '服务未接受检测请求，请检查协议配置': 'The provider rejected the test request. Check protocol settings.',
  '未收到预期结果，暂不能确认能力': 'The expected output was missing. Capability remains unconfirmed.',
  '服务响应格式无法识别': 'The provider response format was not recognized.',
  '当前协议尚不支持自动检测，请手动配置': 'Automatic testing is unavailable for this protocol. Configure it manually.',
  '检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。': 'Results apply to the current provider and model settings. Timeouts and network errors do not mean a capability is unsupported.',
  '能力检测失败，请稍后重试': 'Capability testing failed. Try again later.',
  '检测能力': 'Test capabilities', '正在检测能力…': 'Testing capabilities…',
  '使用已保存的服务与模型配置': 'Uses saved provider and model settings',
  '正在检查连接、图片输入、工具调用与流式输出…': 'Checking connection, image input, tool calling and streaming…',
  '原生识图与不支持图片输入的配置冲突': 'Native vision conflicts with unsupported image input.',
  'Token 上限必须填写允许范围内的整数': 'Token limits must be whole numbers within the allowed range.',
  '最大输出不能超过上下文窗口': 'Maximum output cannot exceed the context window.',
  '对话模型可单独支持图片输入；图片生成和视频生成用于创作成果。': 'Chat models can also accept images. Image and video generation models create media.',
  '按服务实际支持的能力设置，未知项可检测确认。': 'Configure the capabilities supported by your provider. Test unknown capabilities to verify them.',
  '高级设置': 'Advanced settings', '图片处理方式': 'Image handling',
  '自动选择': 'Automatic', '模型原生识图': 'Native vision', '独立视觉服务': 'Separate vision service',
  '上下文窗口': 'Context window', '最大输出 Token': 'Maximum output tokens',
  '自动选择优先使用已确认的原生视觉能力；兼容识图需要配置独立视觉服务。': 'Automatic mode prefers confirmed native vision. Fallback requires a separate vision service.',
}

export const ja = {
  '{0}的模型列表': '{0}のモデル一覧',
  '模型列表已收起，点击展开查看配置': 'モデル一覧は折りたたまれています。展開すると設定を確認できます。',
}

export const ko = {
  '{0}的模型列表': '{0}의 모델 목록',
  '模型列表已收起，点击展开查看配置': '모델 목록이 접혀 있습니다. 펼쳐서 설정을 확인하세요.',
}
