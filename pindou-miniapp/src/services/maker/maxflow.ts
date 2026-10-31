// 最大流 / 最小割（Dinic，迭代写法，免得长增广路把调用栈撑爆）：整张配色（mrf.ts）每一步解一次二值能量用。
// 边存在定长的类型数组里，reset() 以后重复用，不每次重新分配。
export class Flow {
  n = 0
  m = 0
  head: Int32Array
  next: Int32Array
  to: Int32Array
  cap: Float64Array
  level: Int32Array
  iter: Int32Array
  queue: Int32Array
  stack: Int32Array
  edges: Int32Array
  constructor(maxNodes: number, maxEdges: number) {
    this.head = new Int32Array(maxNodes)
    this.level = new Int32Array(maxNodes)
    this.iter = new Int32Array(maxNodes)
    this.queue = new Int32Array(maxNodes)
    this.stack = new Int32Array(maxNodes + 1)
    this.edges = new Int32Array(maxNodes + 1)
    this.next = new Int32Array(maxEdges * 2)
    this.to = new Int32Array(maxEdges * 2)
    this.cap = new Float64Array(maxEdges * 2)
  }
  reset(n: number) {
    this.n = n
    this.m = 0
    this.head.fill(-1, 0, n)
  }
  /** u→v 容量 c，v→u 容量 r（无向边 r = c）。 */
  add(u: number, v: number, c: number, r = 0) {
    const e = this.m
    this.to[e] = v
    this.cap[e] = c
    this.next[e] = this.head[u]
    this.head[u] = e
    this.to[e + 1] = u
    this.cap[e + 1] = r
    this.next[e + 1] = this.head[v]
    this.head[v] = e + 1
    this.m += 2
  }
  private bfs(s: number, t: number) {
    const { level, head, next, to, cap, queue: q } = this
    level.fill(-1, 0, this.n)
    let h = 0,
      tl = 0
    q[tl++] = s
    level[s] = 0
    while (h < tl) {
      const u = q[h++]
      for (let e = head[u]; e >= 0; e = next[e])
        if (cap[e] > 1e-9 && level[to[e]] < 0) {
          level[to[e]] = level[u] + 1
          q[tl++] = to[e]
        }
    }
    return level[t] >= 0
  }
  max(s: number, t: number) {
    const { head, next, to, cap, level, iter, stack, edges } = this
    let total = 0
    while (this.bfs(s, t)) {
      iter.set(head.subarray(0, this.n))
      for (;;) {
        // 沿层次图找一条增广路
        let sp = 0,
          ep = 0
        stack[sp++] = s
        let found = false
        while (sp) {
          const u = stack[sp - 1]
          if (u === t) {
            found = true
            break
          }
          let e = iter[u]
          for (; e >= 0; e = next[e]) if (cap[e] > 1e-9 && level[to[e]] === level[u] + 1) break
          iter[u] = e
          if (e < 0) {
            // 死路：退一步，并让上一个点跳过这条边
            sp--
            level[u] = -1
            if (ep) {
              const pe = edges[--ep]
              iter[stack[sp - 1]] = next[pe]
            }
            continue
          }
          stack[sp++] = to[e]
          edges[ep++] = e
        }
        if (!found) break
        let f = Infinity
        for (let k = 0; k < ep; k++) f = Math.min(f, cap[edges[k]])
        for (let k = 0; k < ep; k++) {
          cap[edges[k]] -= f
          cap[edges[k] ^ 1] += f
        }
        total += f
      }
    }
    return total
  }
  /** 最小割里和源点同一边的点。 */
  sourceSide(s: number) {
    const { head, next, to, cap, queue: q } = this
    const seen = new Uint8Array(this.n)
    let h = 0,
      tl = 0
    q[tl++] = s
    seen[s] = 1
    while (h < tl) {
      const u = q[h++]
      for (let e = head[u]; e >= 0; e = next[e])
        if (cap[e] > 1e-9 && !seen[to[e]]) {
          seen[to[e]] = 1
          q[tl++] = to[e]
        }
    }
    return seen
  }
}
