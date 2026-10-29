import React, { useEffect, useRef } from 'react'
import { mountLandingParticles } from './landing-particles.js'

export default function LandingAtmosphere() {
  const canvas = useRef(null)
  useEffect(() => mountLandingParticles(canvas.current), [])
  return <canvas ref={canvas} className="public-particles" aria-hidden="true" />
}
