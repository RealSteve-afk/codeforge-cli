import { consumeSse, extractSseText, sseEventText } from './sse'

describe('extractSseText', () => {
  it('joins text events and ignores keepalive', () => {
    const stream = [
      'event: text\ndata: "Hello "',
      'event: keepalive\ndata: {}',
      'event: text\ndata: {"content":"world"}',
      '',
    ].join('\n\n')
    expect(extractSseText(stream)).toBe('Hello world')
  })

  it('throws on error events', () => {
    expect(() => extractSseText('event: error\ndata: {"message":"quota exceeded"}\n\n')).toThrow(/quota exceeded/)
  })
})

describe('consumeSse', () => {
  it('yields complete events and keeps a partial tail', () => {
    const first = consumeSse('event: text\ndata: "Hel"\n\nevent: text\ndata: "lo')
    expect(first.events).toHaveLength(1)
    expect(sseEventText(first.events[0])).toBe('Hel')
    const second = consumeSse(`${first.rest}"\n\n`)
    expect(sseEventText(second.events[0])).toBe('lo')
    expect(second.rest).toBe('')
  })

  it('classifies error and ignores keepalive as other', () => {
    const { events } = consumeSse('event: keepalive\ndata: {}\n\nevent: error\ndata: {"message":"quota"}\n\n')
    expect(events.map((event) => event.type)).toEqual(['other', 'error'])
  })
})
