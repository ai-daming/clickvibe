/** Consuming line buffer: completed lines are returned once; only the unfinished fragment remains. */
export class LineBuffer {
  #partial = ''
  #pendingCr = false

  appendChunk(chunk: string): string[] {
    const lines: string[] = []
    const endLine = () => {
      lines.push(this.#partial)
      this.#partial = ''
    }
    for (const character of chunk) {
      if (this.#pendingCr) {
        this.#pendingCr = false
        endLine()
        if (character === '\n') continue
      }
      if (character === '\r') {
        this.#pendingCr = true
      } else if (character === '\n') {
        endLine()
      } else {
        this.#partial += character
      }
    }
    return lines
  }

  flush(): string[] {
    if (this.#pendingCr) {
      this.#pendingCr = false
      const line = this.#partial
      this.#partial = ''
      return [line]
    }
    if (this.#partial === '') return []
    const line = this.#partial
    this.#partial = ''
    return [line]
  }
}
