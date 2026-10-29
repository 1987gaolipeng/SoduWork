import React from 'react'
import '../../../client/core/connector-brand.js'
import './connector-icon.css'
const bundled = import.meta.glob('../../../client/assets/connector-brands/*.{svg,png,ico}', { eager: true, query: '?url', import: 'default' })
const assets = Object.fromEntries(Object.entries(bundled).map(([path, url]) => [path.split('/').pop(), url]))
export default function ConnectorIcon({ value }) {
  const file = window.SoduWorkConnectorBrand.asset(value)
  return file && assets[file] ? <span className="connector-product-icon" aria-hidden="true"><img src={assets[file]} alt="" width="24" height="24" /></span> : null
}
