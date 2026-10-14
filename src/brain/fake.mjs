// Scripted brain for tests: `script(input, ctx)` returns a Classification.
export class FakeBrain {
  constructor(script) { this.script = script; this.calls = []; }
  async classify(input, ctx) { this.calls.push({ input, ctx }); return this.script(input, ctx); }
}
