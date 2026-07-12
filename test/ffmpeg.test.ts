import { describe, it, expect } from 'vitest'
import { chooseFps, chooseAudioArgs, buildWavePicArgs, buildRenderArgs } from '../src/lib/ffmpeg.js'

describe('chooseFps', () => {
  it('honors an explicit fps', () => {
    expect(chooseFps('static', 1280, 100, 7)).toBe(7)
  })
  it('static: round(width/dur) clamped to 1..10', () => {
    expect(chooseFps('static', 1280, 14400)).toBe(1)   // 4h set -> <1 -> clamp 1
    expect(chooseFps('static', 1280, 200)).toBe(6)     // round(6.4)
    expect(chooseFps('static', 1280, 100)).toBe(10)    // round(12.8) -> clamp 10
  })
  it('waves defaults to 5', () => {
    expect(chooseFps('waves', 1280, 100)).toBe(5)
  })
})

describe('chooseAudioArgs', () => {
  it('copies aac/mp3/alac', () => {
    expect(chooseAudioArgs('aac')).toEqual(['-c:a', 'copy'])
    expect(chooseAudioArgs(' mp3 ')).toEqual(['-c:a', 'copy'])
  })
  it('transcodes opus to aac', () => {
    expect(chooseAudioArgs('opus')).toEqual(['-c:a', 'aac', '-b:a', '192k'])
  })
})

describe('buildWavePicArgs', () => {
  it('matches ps1 showwavespic invocation', () => {
    expect(buildWavePicArgs('/a.m4a', '1280x720', '/w.png')).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
      '-i', '/a.m4a', '-filter_complex', 'showwavespic=s=1280x720:colors=cyan',
      '-frames:v', '1', '-update', '1', '/w.png',
    ])
  })
})

describe('buildRenderArgs static', () => {
  it('produces the overlay/playhead graph and mapping', () => {
    const args = buildRenderArgs({
      style: 'static', mode: 'line', size: '1280x720', fps: 1, durSec: 14400,
      audioInput: '/a.m4a', wavePng: '/w.png', encoder: 'nvenc',
      audioArgs: ['-c:a', 'copy'], outFile: '/out.mp4',
    })
    expect(args).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-nostats',
      '-loop', '1', '-framerate', '1', '-i', '/w.png',
      '-f', 'lavfi', '-i', 'color=red:s=4x720:r=1',
      '-i', '/a.m4a',
      '-filter_complex', "[0:v][1:v]overlay=x='(main_w-overlay_w)*t/14400.000':y=0,format=yuv420p[v]",
      '-map', '[v]', '-map', '2:a', '-shortest',
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28',
      '-g', '5',
      '-c:a', 'copy', '/out.mp4',
    ])
  })
})

describe('buildRenderArgs waves', () => {
  it('produces showwaves graph, no gop, x264', () => {
    const args = buildRenderArgs({
      style: 'waves', mode: 'p2p', size: '1280x720', fps: 5, durSec: 100,
      audioInput: '/a.m4a', encoder: 'x264', audioArgs: ['-c:a', 'aac', '-b:a', '192k'], outFile: '/out.mp4',
    })
    expect(args).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1', '-nostats',
      '-i', '/a.m4a',
      '-filter_complex', '[0:a]showwaves=s=1280x720:mode=p2p:rate=5,format=yuv420p[v]',
      '-map', '[v]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k', '/out.mp4',
    ])
  })
})
