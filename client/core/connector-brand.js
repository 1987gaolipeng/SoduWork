/* Bundled connector artwork: reviewed product assets or original category icons.
 * No remote image requests or user-controlled asset paths; names retain identity. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkConnectorBrand = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  const files = Object.freeze({
  "sqlite": "sqlite.svg",
  "redis": "redis.svg",
  "mongodb": "mongodb.svg",
  "clickhouse": "clickhouse.svg",
  "elasticsearch": "elasticsearch.svg",
  "aws-ec2": "aws-ec2.svg",
  "aliyun-ecs": "aliyun-ecs.svg",
  "huawei-cloud": "huawei-cloud.svg",
  "azure": "category-cloud.svg",
  "google-cloud": "google-cloud.svg",
  "tencent-cloud": "category-cloud.svg",
  "volcengine-ecs": "category-cloud.svg",
  "airtable": "airtable.svg",
  "asana": "asana.svg",
  "canva": "canva.svg",
  "clickup": "clickup.svg",
  "confluence": "confluence.svg",
  "discord": "discord.svg",
  "dropbox": "dropbox.svg",
  "elevenlabs": "elevenlabs.svg",
  "excel-online": "category-spreadsheet.svg",
  "figma": "figma.svg",
  "ga4": "ga4.svg",
  "github": "github.svg",
  "gitlab": "gitlab.svg",
  "gmail": "gmail.svg",
  "google-ads": "google-ads.svg",
  "google-calendar": "google-calendar.svg",
  "google-drive": "google-drive.svg",
  "google-meet": "google-meet.svg",
  "google-sheets": "google-sheets.svg",
  "hubspot": "hubspot.svg",
  "intercom": "intercom.svg",
  "jira": "jira.svg",
  "linear": "linear.svg",
  "mailchimp": "mailchimp.svg",
  "microsoft-teams": "category-meeting.svg",
  "miro": "miro.svg",
  "mysql": "mysql.svg",
  "notion": "notion.svg",
  "onedrive": "category-cloud.svg",
  "outlook": "category-email.svg",
  "postgres": "postgres.svg",
  "s3": "s3.svg",
  "salesforce": "salesforce.svg",
  "sharepoint": "category-documents.svg",
  "shopify": "shopify.svg",
  "slack": "slack.svg",
  "stripe": "stripe.svg",
  "telegram": "telegram.svg",
  "trello": "trello.svg",
  "zendesk": "zendesk.svg",
  "zoho-crm": "zoho-crm.svg",
  "zoom": "zoom.svg",
  "wecom": "category-chat.svg",
  "dingtalk": "category-chat.svg",
  "feishu": "category-chat.svg",
  "yuque": "category-documents.svg",
  "runway": "category-video.svg",
  "kling": "category-video.svg",
  "volcengine-ark": "category-cloud.svg",
  "tencent-meeting": "category-meeting.svg"
});
  const names = Object.freeze({
  "airtable": "airtable",
  "asana": "asana",
  "canva": "canva",
  "clickup": "clickup",
  "confluence cloud": "confluence",
  "discord": "discord",
  "dropbox": "dropbox",
  "elevenlabs": "elevenlabs",
  "excel online": "excel-online",
  "figma": "figma",
  "google analytics 4": "ga4",
  "github": "github",
  "gitlab": "gitlab",
  "gmail": "gmail",
  "google ads": "google-ads",
  "google calendar": "google-calendar",
  "google drive": "google-drive",
  "google meet": "google-meet",
  "google sheets": "google-sheets",
  "hubspot": "hubspot",
  "intercom": "intercom",
  "jira cloud": "jira",
  "可灵 kling": "kling",
  "linear": "linear",
  "mailchimp": "mailchimp",
  "microsoft teams": "microsoft-teams",
  "miro": "miro",
  "mysql": "mysql",
  "notion": "notion",
  "onedrive": "onedrive",
  "outlook mail": "outlook",
  "postgresql": "postgres",
  "runway": "runway",
  "s3 / minio 对象存储": "s3",
  "salesforce": "salesforce",
  "sharepoint online": "sharepoint",
  "shopify": "shopify",
  "slack": "slack",
  "stripe": "stripe",
  "telegram bot api": "telegram",
  "腾讯会议": "tencent-meeting",
  "trello": "trello",
  "火山方舟 ark": "volcengine-ark",
  "语雀": "yuque",
  "zendesk": "zendesk",
  "zoho crm": "zoho-crm",
  "zoom": "zoom",
  "企业微信": "wecom",
  "钉钉": "dingtalk",
  "飞书": "feishu",
  "腾讯会议（基于官方 mcp）": "tencent-meeting",
  "google analytics": "ga4",
  "teams": "microsoft-teams"
});
  const hosts = Object.freeze({ 'api.figma.com':'figma', 'mcp.figma.com':'figma', 'api.github.com':'github', 'api.notion.com':'notion', 'mcp.notion.com':'notion', 'open.feishu.cn':'feishu', 'mcp.feishu.cn':'feishu', 'qyapi.weixin.qq.com':'wecom', 'api.dingtalk.com':'dingtalk', 'mcp.api-inference.modelscope.net':'' });
  function identify(value) {
    if (typeof value === 'string') return Object.hasOwn(files,value) ? value : names[value.toLowerCase()] || '';
    const item = value || {};
    for (const candidate of [item.providerId, item.templateKey, item.key, item.provider, item.id]) {
      const key = String(candidate || '').replace(/^connector-/, '');
      if (Object.hasOwn(files, key)) return key;
    }
    if (/^soduwork-feishu-/.test(String(item.id || ''))) return 'feishu';
    const preset = item.template || item;
    if (preset.command === 'soduwork-connector' && Object.hasOwn(files, preset.args?.[0])) return preset.args[0];
    try { const host = new URL(item.url || preset.url).hostname.toLowerCase(); if (Object.hasOwn(hosts,host)) return hosts[host]; } catch (_) {}
    return names[String(item.name || '').toLowerCase()] || '';
  }
  function asset(value) { return files[identify(value)] || ''; }
  function image(value) {
    const file = asset(value);
    return file ? '<img class="cap-connector-product-icon" src="assets/connector-brands/' + file + '" alt="" width="28" height="28" decoding="async" draggable="false">' : '';
  }
  return Object.freeze({ identify, asset, image, files });
});
