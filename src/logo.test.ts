import { displayWidth, CODEFORGE_BRAND, codeforgeBanner, codeforgeProductSurfaces, codeforgeSplash, codeforgeSplashFrame, codeforgeSplashHeight, codeforgeWelcomeCopy, codeforgeWordmark, stripAnsi } from './logo'

describe('codeforge logo', () => {
  it('renders the volumetric ∞ Möbius with the wordmark', () => {
    const splash = codeforgeSplash(80, false)
    expect(splash).toContain('CodeForge')
    expect(splash).toContain(CODEFORGE_BRAND.headline)
    expect(splash).toMatch(/[@%#*+=.-]/)
    expect(stripAnsi(splash)).not.toMatch(/NaN/)
    expect(codeforgeWordmark()).toMatch(/CodeForge/)
    expect(codeforgeBanner(80, 0, false)).toContain(CODEFORGE_BRAND.headline)
  })

  it('keeps splash height stable as the twist travels', () => {
    const height = codeforgeSplashHeight(80)
    expect(codeforgeSplashFrame(80, false, 0).split('\n')).toHaveLength(height)
    expect(codeforgeSplashFrame(80, false, Math.PI).split('\n')).toHaveLength(height)
    expect(codeforgeSplashFrame(80, false, Math.PI * 2).split('\n')).toHaveLength(height)
    expect(codeforgeSplash(40, false)).toContain(CODEFORGE_BRAND.headline)
  })

  it('paints the brand gradient and measures CJK as two cells', () => {
    const colored = codeforgeSplash(80, true)
    expect(colored).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/)
    expect(colored).not.toMatch(/NaN/)
    expect(displayWidth('锻造')).toBe(4)
    expect(displayWidth('锻造锻造')).toBe(8)
    expect(displayWidth('CodeForge')).toBe(9)
  })

  it('first surfaces carry the CodeForge brand with a Möbius frame', () => {
    const surfaces = codeforgeProductSurfaces()
    for (const text of [surfaces.splash, surfaces.welcome, surfaces.helpAbout]) {
      expect(text).toContain(CODEFORGE_BRAND.zh)
      expect(text).toMatch(/CodeForge|CODEFORGE/)
      expect(text).toContain(CODEFORGE_BRAND.headline)
      expect(text).not.toMatch(/Forge Build|SpaceFORGE|forge\.com/i)
    }
    expect(surfaces.splash).toMatch(/[@%#*+=.-]/)
    expect(codeforgeWelcomeCopy(true, false).join('\n')).toContain('/login')
    expect(codeforgeWordmark()).toContain('CodeForge')
  })
})
