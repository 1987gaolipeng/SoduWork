import React from 'react'
import { translateText as tx, localeMap, useLocale } from '../i18n.js'

const SETUP_TYPES = localeMap(() => ({
  text: '文本', textarea: '多行文本', boolean: '开关', number: '数字',
  select: '单选', multiselect: '多选', url: '网址',
}))
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const scalar = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''

function displayValue(value, field) {
  if (typeof value === 'boolean') return value ? tx("是") : tx("否")
  if (Array.isArray(value)) return value.length ? value.map((item) => displayValue(item, field)).join(' · ') : tx("无选项")
  const raw = scalar(value)
  if (raw === '') return tx("空文本")
  const option = Array.isArray(field.options) && field.options.find((item) => scalar(item?.value) === raw)
  return option?.label && option.label !== raw ? scalar(option.label) + ' (' + raw + ')' : raw
}

// Review only the selected immutable version. Never collect installation values
// or credentials here; the client owns personal preferences and OAuth consent.
export default function PluginInstallContract({ version }) {
  useLocale()
  const titleId = React.useId()
  const setup = version?.manifest?.setup || {}
  const fields = Array.isArray(setup.preferences)
    ? setup.preferences.filter((field) => field && typeof field === 'object' && !Array.isArray(field)) : []
  return <section className="plugin-preview-setup" aria-labelledby={titleId}>
    <header><div><h4 id={titleId}>{tx("安装设置清单")}</h4>
      <p>{tx("以下内容来自所选版本，仅供审核；修改须发布新版本。")}</p></div>
      <span className="plugin-setup-version">v{version?.version || '—'}</span></header>
    {(setup.title || setup.description) && <div className="plugin-setup-description">
      {setup.title && <b>{scalar(setup.title)}</b>}
      {setup.description && <p>{scalar(setup.description)}</p>}
    </div>}
    {fields.length ? <ol className="plugin-setup-fields">{fields.map((field, index) => {
      const supported = own(SETUP_TYPES, field.type) && field.sensitive !== true
      return <li className="plugin-setup-field" key={scalar(field.key) || index}>
        <div className="plugin-setup-field-title"><b>{scalar(field.label) || scalar(field.key)}</b>
          <span>{supported ? SETUP_TYPES[field.type] : tx("不支持的字段类型")}</span>
          <span>{field.required ? tx("必填") : tx("可选")}</span></div>
        <div className="plugin-setup-field-key"><code>{scalar(field.key)}</code>
          {field.group && <span>{scalar(field.group)}</span>}</div>
        {field.description && <p>{scalar(field.description)}</p>}
        {supported && <dl>
          <div><dt>{tx("默认值")}</dt><dd>{own(field, 'default') ? displayValue(field.default, field) : tx("未设置")}</dd></div>
          {Array.isArray(field.options) && field.options.length > 0 && <div><dt>{tx("可选值")}</dt>
            <dd>{field.options.map((option, optionIndex) => <span className="plugin-setup-option" key={optionIndex}>
              {displayValue(option?.value, field)}</span>)}</dd></div>}
          {['minimum', 'maximum', 'minLength', 'maxLength'].some((key) => typeof field[key] === 'number') && <div>
            <dt>{tx("取值限制")}</dt><dd>
              {typeof field.minimum === 'number' && <span className="plugin-setup-option">{tx("最小值：{0}", [field.minimum])}</span>}
              {typeof field.maximum === 'number' && <span className="plugin-setup-option">{tx("最大值：{0}", [field.maximum])}</span>}
              {typeof field.minLength === 'number' && <span className="plugin-setup-option">{tx("最少字符：{0}", [field.minLength])}</span>}
              {typeof field.maxLength === 'number' && <span className="plugin-setup-option">{tx("最多字符：{0}", [field.maxLength])}</span>}
            </dd></div>}
          {field.placeholder && <div><dt>{tx("输入提示")}</dt><dd>{scalar(field.placeholder)}</dd></div>}
        </dl>}
      </li>
    })}</ol> : <p className="plugin-setup-empty">{tx("此版本未声明安装偏好。")}</p>}
    <footer>{tx("账号、密钥与 OAuth 授权由连接器单独管理，不写入安装偏好。")}</footer>
  </section>
}
