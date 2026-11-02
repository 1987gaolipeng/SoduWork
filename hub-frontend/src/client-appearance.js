// Send complete built-in preferences through the existing persisted config API.
// Older clients already understand these fields; a transient command is unnecessary.
export const remoteSkins = ['bear-vivid', 'box-biz', 'diamond-ice']
export function skinConfig(skinId) {
  if (!remoteSkins.includes(skinId)) throw new Error('Unsupported remote skin')
  return { character: skinId.split('-')[0], theme: 'vivid', tube: 'glass',
    _lastSkinId: skinId, _defaultLogoVersion: 1 }
}
export function selectedSkin(config = {}) {
  return remoteSkins.find(id => {
    const skin = skinConfig(id)
    return config.character === skin.character && (config.theme || 'vivid') === skin.theme &&
      (config.tube || 'glass') === skin.tube
  }) || ''
}
