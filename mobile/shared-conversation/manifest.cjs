'use strict';

// These are source dependencies, not a fork of the desktop conversation.
// Keep the ordering explicit: the desktop renderer uses browser globals.
// Reuse the desktop catalogs in their original order. Do not enable its body-wide
// DOM adapter: the mobile adapter translates only explicitly owned UI controls.
const localeScripts = require('../../client/core/locales/manifest.json')
  .filter(file => file === 'locale-registry.js' || file.startsWith('en-US'))
  .map(file => 'core/locales/' + file);
const scripts = [
  ...localeScripts,
  'core/i18n.js', 'core/model-choice.js', 'core/plugin-icon.js',
  'components/panels/agent-brand.js',
  'vendor/markdown/marked.umd.js', 'vendor/markdown/highlight.min.js',
  'vendor/markdown/hljs-theme.js', 'vendor/markdown/diff.min.js',
  'vendor/markdown/purify.min.js',
  'components/panels/work-intent.js', 'components/panels/work-composer.js',
  'components/panels/panels-compose-skills.js',
  'components/panels/conversation-attachments.js',
  'components/panels/library-file-icons.js',
  'components/panels/chat-output-links.js', 'components/panels/chat-deliveries.js',
  'components/panels/chat-thinking-collapse.js', 'components/panels/chat-dom-patch.js',
  'components/panels/chat-decorate-carry.js', 'components/panels/panels-chat-tools.js',
  'components/panels/chat-tool-details.js', 'components/panels/panels-chat-status.js',
  'components/panels/panels-chat-chrome.js',
  'components/panels/chat-message-plugins.js',
  'components/panels/plugin-ui-host.js', 'components/panels/plugin-input-sheet.js',
  'components/panels/compose-candidate-navigation.js',
  'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js',
  'components/panels/chat-mate-mention.js',
  'components/panels/chat-session-controls.js', 'components/panels/chat-runtime-picker.js',
  'components/panels/chat-composer-controls.js', 'components/panels/chat-task-start.js',
  'components/panels/chat-collaboration-store.js', 'components/panels/chat-task-controller.js',
  'components/panels/chat-context-meter.js', 'components/panels/chat-scroll-follow.js',
  'components/panels/chat-markdown.js', 'components/panels/chat-reading-position.js',
  'components/panels/chat-read-aloud-core.js', 'components/panels/chat-read-aloud.js',
  'components/panels/chat-acceptance-results.js', 'components/panels/chat-message-renderer.js',
  'components/panels/chat-send-queue.js', 'components/panels/chat-work-intent.js',
  'components/panels/chat-work-cards.js', 'components/panels/chat-draft-recovery.js',
  'components/panels/chat-composer-bindings.js', 'components/panels/chat-session-controller.js',
  'components/panels/panels-chat.js',
];
const styles = [
  'components/panels/plugin-ui-host.css', 'components/panels/plugin-input-sheet.css',
  'components/panels/chat-deliveries.css',
  'theme/variables.css', 'components/panels/agent-brand.css',
  'components/panels/panels-chat.css', 'components/panels/work-composer.css',
  'components/panels/conversation-attachments.css',
  'components/panels/chat-plugin-mention.css', 'components/panels/chat-session-controls.css',
  'components/panels/chat-work-cards.css', 'components/panels/work-intent.css',
  'components/panels/chat-collaboration.css',
];
module.exports = { scripts, styles };
