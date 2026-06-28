/** @jsxRuntime automatic */

import { useEffect, useRef, useState, type JSX } from 'react'

const VERTEX_SHADER = `attribute vec2 a_position;
varying vec2 vScreenUv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  vScreenUv = a_position * 0.5 + 0.5;
}`

const FRAGMENT_SHADER = `
precision mediump float;

varying vec2 vScreenUv;

uniform float u_time;
uniform vec2 u_pointer;
uniform float u_pointer_active;
uniform float u_pointer_radius;
uniform float u_pointer_strength;
uniform vec3 u_color_a;
uniform vec3 u_color_b;
uniform vec3 u_color_c;
uniform vec3 u_gray;
uniform float u_color_shift;
uniform float u_accent_height;
uniform float u_stipple;
uniform float u_grain;
uniform float u_aspect;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash2(vec2 p) {
  return vec2(hash(p), hash(p + vec2(127.1, 311.7)));
}

vec3 horizontalAccent(float x) {
  // Y = u_color_a, B = u_color_b, O = u_color_c.
  // Cycle: B-O  ↔  Y-B. B is the shared hub, so transitions pass through
  // pure B and the third color is never visible alongside the active pair.
  //
  // Phase segments per cycle (length 1 each, total 4):
  //   [0, 1) stable B-O          — B on left, O on right
  //   [1, 1.5) O → B on the right (screen collapses to pure B)
  //   [1.5, 2) B → Y on the left (screen becomes Y-B)
  //   [2, 3) stable Y-B           — Y on left, B on right
  //   [3, 3.5) Y → B on the left  (screen collapses to pure B)
  //   [3.5, 4) B → O on the right (screen becomes B-O)
  float phase = u_time * 0.00015 + u_color_shift * 0.4;
  float p = mod(phase, 4.0);

  vec3 leftCol = u_color_b;
  vec3 rightCol = u_color_c;
  if (p < 1.0) {
    leftCol = u_color_b;
    rightCol = u_color_c;
  } else if (p < 1.5) {
    float t = (p - 1.0) / 0.5;
    leftCol = u_color_b;
    rightCol = mix(u_color_c, u_color_b, t);
  } else if (p < 2.0) {
    float t = (p - 1.5) / 0.5;
    leftCol = mix(u_color_b, u_color_a, t);
    rightCol = u_color_b;
  } else if (p < 3.0) {
    leftCol = u_color_a;
    rightCol = u_color_b;
  } else if (p < 3.5) {
    float t = (p - 3.0) / 0.5;
    leftCol = mix(u_color_a, u_color_b, t);
    rightCol = u_color_b;
  } else {
    float t = (p - 3.5) / 0.5;
    leftCol = u_color_b;
    rightCol = mix(u_color_b, u_color_c, t);
  }

  return mix(leftCol, rightCol, clamp(x, 0.0, 1.0));
}

void main() {
  vec2 st = vScreenUv;

  float t = u_time * 0.0004;
  st += vec2(sin(t * 1.2) * 0.008, cos(t * 0.95) * 0.006);

  vec2 dPtr = st - u_pointer;
  vec2 dPtrA = vec2(dPtr.x * u_aspect, dPtr.y);
  float pDist = length(dPtrA);
  float pNorm = pDist / max(0.001, u_pointer_radius);
  // Profile that is zero at the cursor (no singularity), peaks near pNorm ≈ 0.7,
  // and falls off smoothly. Multiplying by pNorm cancels the 1/r in the direction.
  float pFall = pNorm * exp(-pNorm * pNorm * 1.4);
  vec2 pDir = dPtrA / max(0.001, pDist);
  st += pDir * pFall * u_pointer_strength * u_pointer_active;

  if (u_stipple > 0.001) {
    vec2 n1 = (hash2(st * 480.0) - 0.5) * 2.0;
    vec2 n2 = (hash2(st * 170.0) - 0.5) * 2.0;
    vec2 n3 = (hash2(st * 60.0) - 0.5) * 2.0;
    vec2 noff = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
    st += noff * u_stipple * 0.014;
  }

  vec3 accent = horizontalAccent(st.x);

  float ny = clamp(st.y, 0.0, 1.0);
  float fade = 1.0 - smoothstep(0.0, max(0.05, u_accent_height), ny);
  fade = pow(fade, 0.9);

  float corner = (1.0 - ny) * (0.5 + 0.5 * sin(st.x * 3.14159));
  fade = mix(fade, max(fade, corner * 0.35), 0.4);

  vec3 color = mix(u_gray, accent, fade);

  if (u_grain > 0.001) {
    float g1 = hash(vScreenUv * 600.0 + u_time * 0.0002) - 0.5;
    float g2 = hash(vScreenUv * 220.0 + 0.27) - 0.5;
    float g = g1 * 0.7 + g2 * 0.3;
    color += g * u_grain;
  }

  gl_FragColor = vec4(color, 1.0);
}`

const COLOR_A: [number, number, number] = [0.9647058823529412, 0.8392156862745098, 0.6274509803921569] // #F6D6A0
const COLOR_B: [number, number, number] = [0.7372549019607844, 0.8235294117647058, 0.9176470588235294] // #BCD2EA
const COLOR_C: [number, number, number] = [0.9568627450980393, 0.7843137254901961, 0.7294117647058823] // #F4C8BA
const GRAY: [number, number, number] = [0.9411764705882353, 0.9372549019607843, 0.9333333333333333] // #F0EFEE

type UniformValue = number | readonly [number, number] | readonly [number, number, number]

const STATIC_UNIFORMS: Record<string, UniformValue> = {
  u_accent_height: 0.78,
  u_stipple: 0.9,
  u_grain: 0.025,
  u_pointer_radius: 0.5,
  u_pointer_strength: 0.5,
}

const COLOR_SHIFT_PERIOD_MS = 24000
const COLOR_SHIFT_RANGE = 0.45

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Failed to create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader compile error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('Failed to create program')
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Program link error'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function setUniform(gl: WebGLRenderingContext, location: WebGLUniformLocation | null, value: UniformValue): void {
  if (!location) return
  if (typeof value === 'number') {
    gl.uniform1f(location, value)
    return
  }
  if (value.length === 2) {
    const [x, y] = value as [number, number]
    gl.uniform2f(location, x, y)
    return
  }
  if (value.length === 3) {
    const [x, y, z] = value as [number, number, number]
    gl.uniform3f(location, x, y, z)
    return
  }
}

type StarterCanvasProps = {
  /** Fade the canvas in on first paint. Off for the sandbox app — the editor placeholder handles the one-time fade. */
  fadeIn?: boolean
}

export function StarterCanvas({ fadeIn = true }: StarterCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [isCanvasReady, setIsCanvasReady] = useState(!fadeIn)
  const hasFadedInRef = useRef(false)
  const pointerRef = useRef<[number, number]>([0.5, 0.2])
  const pointerTargetRef = useRef<[number, number]>([0.5, 0.2])
  const pointerActiveRef = useRef<number>(0)
  const pointerActiveTargetRef = useRef<number>(0)
  const pointerMotionRef = useRef<number>(0)
  const lastMoveTimeRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    if (!gl) return

    const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    if (!buffer) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const posLocation = gl.getAttribLocation(program, 'a_position')
    if (posLocation >= 0) {
      gl.enableVertexAttribArray(posLocation)
      gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0)
    }

    setUniform(gl, gl.getUniformLocation(program, 'u_color_a'), COLOR_A)
    setUniform(gl, gl.getUniformLocation(program, 'u_color_b'), COLOR_B)
    setUniform(gl, gl.getUniformLocation(program, 'u_color_c'), COLOR_C)
    setUniform(gl, gl.getUniformLocation(program, 'u_gray'), GRAY)
    for (const [key, value] of Object.entries(STATIC_UNIFORMS)) {
      setUniform(gl, gl.getUniformLocation(program, key), value)
    }

    const timeLoc = gl.getUniformLocation(program, 'u_time')
    const aspectLoc = gl.getUniformLocation(program, 'u_aspect')
    const pointerLoc = gl.getUniformLocation(program, 'u_pointer')
    const pointerActiveLoc = gl.getUniformLocation(program, 'u_pointer_active')
    const colorShiftLoc = gl.getUniformLocation(program, 'u_color_shift')

    const startTime = performance.now()
    let rafId = 0
    let fadeInRafId = 0

    const setTargetFromClient = (clientX: number, clientY: number): void => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const x = (clientX - rect.left) / rect.width
      const y = 1 - (clientY - rect.top) / rect.height
      pointerTargetRef.current = [Math.min(1.2, Math.max(-0.2, x)), Math.min(1.2, Math.max(-0.2, y))]
    }

    const handlePointerMove = (event: PointerEvent): void => {
      setTargetFromClient(event.clientX, event.clientY)
      if (pointerActiveTargetRef.current < 0.5) {
        pointerRef.current = [pointerTargetRef.current[0], pointerTargetRef.current[1]]
      }
      pointerActiveTargetRef.current = 1
      lastMoveTimeRef.current = performance.now()
    }

    const handlePointerLeave = (): void => {
      pointerActiveTargetRef.current = 0
    }

    canvas.addEventListener('pointermove', handlePointerMove, { passive: true })
    canvas.addEventListener('pointerleave', handlePointerLeave)
    // Touch gestures cancelled by the browser don't fire pointerleave; without this the active-target flag would stay at 1 and the snap-on-first-entry guard would break for later entries.
    canvas.addEventListener('pointercancel', handlePointerLeave)

    const render = (now: number): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      // Wrap on a ~17.4 min cycle (2^20 ms) so u_time stays representable under mediump float — otherwise per-frame phase increments fall below 1 ulp after a few minutes and the gradient stutters on mobile GPUs.
      const elapsed = Math.max(0, now - startTime) % 1048576

      if (timeLoc) gl.uniform1f(timeLoc, elapsed)
      if (aspectLoc) gl.uniform1f(aspectLoc, width / Math.max(1, height))

      // Heavy easing of the rendered pointer toward the raw target gives the
      // cursor effect resistance: it lags behind the real cursor and keeps
      // catching up (then settling) after you stop moving.
      const POSITION_EASE = 0.07
      pointerRef.current = [
        pointerRef.current[0] + (pointerTargetRef.current[0] - pointerRef.current[0]) * POSITION_EASE,
        pointerRef.current[1] + (pointerTargetRef.current[1] - pointerRef.current[1]) * POSITION_EASE,
      ]
      if (pointerLoc) {
        gl.uniform2f(pointerLoc, pointerRef.current[0], pointerRef.current[1])
      }
      const activeTarget = pointerActiveTargetRef.current
      const activeCurrent = pointerActiveRef.current
      const easeRate = activeTarget > activeCurrent ? 0.03 : 0.06
      pointerActiveRef.current = activeCurrent + (activeTarget - activeCurrent) * easeRate

      // Slow decay: keep the displacement alive longer after the cursor stops,
      // and ease back smoothly instead of snapping off.
      const sinceMove = now - lastMoveTimeRef.current
      const motionTarget = lastMoveTimeRef.current > 0 && sinceMove < 220 ? 1 : 0
      const motionEase = motionTarget > pointerMotionRef.current ? 0.18 : 0.015
      pointerMotionRef.current += (motionTarget - pointerMotionRef.current) * motionEase

      if (pointerActiveLoc) {
        gl.uniform1f(pointerActiveLoc, pointerActiveRef.current * pointerMotionRef.current)
      }
      if (colorShiftLoc) {
        const phase = (elapsed / COLOR_SHIFT_PERIOD_MS) * Math.PI * 2
        gl.uniform1f(colorShiftLoc, Math.sin(phase) * COLOR_SHIFT_RANGE)
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (!hasFadedInRef.current) {
        hasFadedInRef.current = true
        if (!fadeIn) {
          setIsCanvasReady(true)
        } else {
          // One frame at opacity 0 so the CSS transition has a starting point.
          fadeInRafId = requestAnimationFrame(() => {
            setIsCanvasReady(true)
          })
        }
      }
      rafId = requestAnimationFrame(render)
    }

    rafId = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(rafId)
      cancelAnimationFrame(fadeInRafId)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerleave', handlePointerLeave)
      canvas.removeEventListener('pointercancel', handlePointerLeave)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }, [fadeIn])

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        opacity: isCanvasReady ? 1 : 0,
        ...(fadeIn ? { transition: 'opacity 0.35s ease' } : null),
      }}
      aria-label="Gradient canvas"
    />
  )
}
