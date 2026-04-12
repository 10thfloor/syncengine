export interface RingEntry {
    seq: number;
    payload: Record<string, unknown>;
    clientId: string;
}

const RING_CAPACITY_DEFAULT = 10_000;

export class RingBuffer {
    private readonly buf: (RingEntry | null)[];
    private readonly cap: number;
    private head = 0;
    private size = 0;

    constructor(capacity: number = RING_CAPACITY_DEFAULT) {
        this.cap = capacity;
        this.buf = new Array(capacity).fill(null);
    }

    push(seq: number, payload: Record<string, unknown>, clientId: string): void {
        this.buf[this.head] = { seq, payload, clientId };
        this.head = (this.head + 1) % this.cap;
        if (this.size < this.cap) this.size++;
    }

    oldestSeq(): number {
        if (this.size === 0) return -1;
        const idx = this.size < this.cap ? 0 : this.head;
        return this.buf[idx]!.seq;
    }

    newestSeq(): number {
        if (this.size === 0) return -1;
        const idx = (this.head - 1 + this.cap) % this.cap;
        return this.buf[idx]!.seq;
    }

    containsSeq(seq: number): boolean {
        if (this.size === 0) return false;
        return seq >= this.oldestSeq() && seq <= this.newestSeq();
    }

    rangeFrom(afterSeq: number): RingEntry[] {
        if (this.size === 0) return [];
        const result: RingEntry[] = [];
        const start = this.size < this.cap ? 0 : this.head;
        for (let i = 0; i < this.size; i++) {
            const entry = this.buf[(start + i) % this.cap]!;
            if (entry.seq > afterSeq) result.push(entry);
        }
        return result;
    }
}
