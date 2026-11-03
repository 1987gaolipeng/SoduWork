// Comma-separated arguments, with CSV-style double quotes for literal commas.
export function parseArguments(text) {
  const args = []
  let value = '', quoted = false, closed = false, inQuotes = false
  const push = () => {
    if (quoted || value.trim()) args.push(quoted ? value : value.trim())
    value = ''; quoted = false; closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++ }
      else if (char === '"') { inQuotes = false; closed = true }
      else value += char
    } else if (char === ',') push()
    else if (closed) {
      if (char.trim()) throw Error('参数的双引号后只能填写英文逗号或空白')
    } else if (char === '"' && !value.trim()) {
      value = ''; quoted = true; inQuotes = true
    } else value += char
  }
  if (inQuotes) throw Error('参数的双引号未闭合')
  push()
  return args
}

export function formatArguments(args) {
  if (typeof args === 'string') return args
  return (args || []).map(arg => {
    const value = String(arg)
    return !value || /[,"\r\n]/.test(value) || value !== value.trim()
      ? '"' + value.replaceAll('"', '""') + '"' : value
  }).join(', ')
}
