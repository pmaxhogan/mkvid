/**
 * One drawing thread of the scene renderer (see render.ts). It owns a Scene
 * and draws whatever frames the main thread asks for, handing each back as a
 * transferred ArrayBuffer. It never touches ffmpeg: encoding happens on the
 * main thread so that every segment of a job goes through the same encoder
 * (NVENC sessions are scarce, and segments from two different encoders cannot
 * be concatenated with a stream copy).
 *
 * Protocol:
 *   in   { type: 'draw', frame }            draw one frame
 *   out  { type: 'ready' }                  scene created
 *   out  { type: 'frame', frame, data }     data = width*height*4 RGBA bytes (transferred)
 *   out  { type: 'error', message }         fatal; the main thread aborts the render
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { AnalysisData, Scene, VizInput } from './types.js'

export interface WorkerInit {
  input: VizInput
  /** Saved analysis file, loaded here by each worker. null only for injected test scenes. */
  analysisPath: string | null
  /** file:// URL of a module exporting createScene; default is ./scene/index.js next to this file. */
  sceneModule: string | null
}

type CreateScene = (input: VizInput, analysis: AnalysisData) => Promise<Scene> | Scene

async function main(): Promise<void> {
  const port = parentPort!
  const init = workerData as WorkerInit
  let scene: Scene
  try {
    let analysis: AnalysisData | null = null
    if (init.analysisPath) {
      const mod = await import('./analysis.js')
      analysis = await mod.loadAnalysis(init.analysisPath)
    }
    const sceneUrl = init.sceneModule ?? new URL('./scene/index.js', import.meta.url).href
    const mod = await import(sceneUrl) as { createScene?: CreateScene }
    if (typeof mod.createScene !== 'function') throw new Error(`${sceneUrl} does not export createScene`)
    scene = await mod.createScene(init.input, analysis as AnalysisData)
  } catch (e: any) {
    port.postMessage({ type: 'error', message: `scene setup failed: ${String(e?.stack || e?.message || e)}` })
    return
  }
  const frameBytes = init.input.width * init.input.height * 4
  port.on('message', (m: { type: 'draw'; frame: number } | { type: 'close' }) => {
    if (m.type === 'close') { try { scene.dispose() } catch { /* ignore */ } port.close(); return }
    try {
      const px = scene.drawFrame(m.frame)
      if (px.byteLength !== frameBytes) throw new Error(`frame ${m.frame}: scene returned ${px.byteLength} bytes, expected ${frameBytes}`)
      // The scene may reuse its buffer for the next frame: copy into a fresh one we can give away.
      const out = new Uint8Array(frameBytes)
      out.set(px)
      port.postMessage({ type: 'frame', frame: m.frame, data: out.buffer }, [out.buffer])
    } catch (e: any) {
      port.postMessage({ type: 'error', message: `frame ${m.frame}: ${String(e?.stack || e?.message || e)}` })
    }
  })
  port.postMessage({ type: 'ready' })
}

void main()
