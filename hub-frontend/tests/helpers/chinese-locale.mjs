// These existing behavior assertions exercise authored Chinese UI explicitly.
// Product default-locale coverage remains in the dedicated i18n suites.
import { beforeEach } from 'node:test'
import { setLocale } from '../../src/i18n.js'
setLocale('zh-CN')
beforeEach(() => setLocale('zh-CN'))
