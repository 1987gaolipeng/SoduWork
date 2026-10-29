import React, { useEffect, useState } from 'react'
import { translateText as tx } from '../i18n.js'
import './plugin-cover-preview.css'

export default function PluginCoverPreview({ url = '', debounceMs = 0 }) {
  let target = ''
  try {
    const parsed = new URL(url.trim())
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) target = parsed.href
  } catch (_) { /* A partially typed URL has no preview yet. */ }
  const [image, setImage] = useState({ src: '', status: 'loading' })
  useEffect(() => {
    const timer = setTimeout(() => setImage({ src: target, status: 'loading' }), debounceMs)
    return () => clearTimeout(timer)
  }, [target, debounceMs])
  const current = Boolean(target && image.src === target)
  const status = current ? image.status : target ? 'loading' : 'empty'
  function settle(next) {
    setImage(previous => previous.src === target ? { ...previous, status: next } : previous)
  }
  return <div className="plugin-cover-preview" data-status={status}>
    {current && <img key={target} src={target} alt={tx('推荐封面')} referrerPolicy="no-referrer"
      onLoad={() => settle('ready')} onError={() => settle('error')} />}
    {status !== 'ready' && <span role="status">{status === 'error'
      ? tx('封面加载失败，请检查图片地址') : status === 'loading'
        ? tx('正在加载封面…') : tx('填写图片 URL 后预览')}</span>}
  </div>
}
