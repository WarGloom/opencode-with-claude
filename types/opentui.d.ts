// The TUI entry imports these at runtime, where OpenCode's OpenTUI runtime
// plugin resolves them to the host's own instances. They are deliberately
// not dependencies of this package, so only the surface in use is declared.

declare module "@opentui/solid" {
  /** Opaque host renderable; this package only passes it back to the host. */
  export type HostNode = object
  export function createElement(tag: string): HostNode
  export function spread(node: HostNode, props: Record<string, unknown>, skipChildren?: boolean): void
}

declare module "solid-js" {
  export function createSignal<T>(value: T): [() => T, (value: T) => T]
}
