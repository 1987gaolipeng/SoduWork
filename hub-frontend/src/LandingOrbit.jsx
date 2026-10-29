import React, { useEffect, useRef } from 'react'
import { translateText as tx } from './i18n.js'
import { PublicIcon as Glyph } from './LandingPreview.jsx'

export default function LandingOrbit() {
  const root = useRef(null)
  useEffect(() => {
    const element = root.current
    let visible = true
    const update = () => { element.dataset.motion = visible && !document.hidden ? 'running' : 'paused' }
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; update() })
    observer.observe(element)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])
  return <div ref={root} className="public-brand-universe" aria-hidden="true">
    <svg className="public-orbit-tracks" viewBox="0 0 500 500" fill="none">
      <g className="orbit-motion-plane orbit-plane-outer">
        <circle className="orbit-dotted-track" cx="250" cy="250" r="243" />
        <circle className="orbit-traveler traveler-purple" cx="250" cy="7" r="3" />
      </g>
      <g className="orbit-motion-plane orbit-plane-inner">
        <ellipse className="orbit-drawn-track" cx="250" cy="250" rx="208" ry="157" pathLength="1" />
        <circle className="orbit-traveler traveler-blue" cx="458" cy="250" r="4" />
      </g>
      <g className="orbit-motion-plane orbit-plane-cross">
        <ellipse className="orbit-drawn-track" cx="250" cy="250" rx="216" ry="160" pathLength="1" />
        <circle className="orbit-traveler traveler-pink" cx="34" cy="250" r="4" />
      </g>
    </svg>
    <div className="public-brand-core"><img src="/soduwork.png" alt="" /><b>SoduWork</b></div>
    <span className="public-orbit-topic topic-chat"><Glyph name="chat" size={20} />{tx('对话与成果')}</span>
    <span className="public-orbit-topic topic-team"><Glyph name="team" size={20} />{tx('需求协作')}</span>
    <span className="public-orbit-topic topic-auto"><Glyph name="sparkle" size={20} />{tx('自动化')}</span>
    <i className="public-orbit-star star-one" /><i className="public-orbit-star star-two" /><i className="public-orbit-star star-three" />
  </div>
}
