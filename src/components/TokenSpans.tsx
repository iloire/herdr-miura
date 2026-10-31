import type { Token } from "../files/highlight";

/// One line of highlighted code. Code is untrusted: tokens are drawn as text.
export function TokenSpans({ tokens }: { tokens: Token[] }) {
  return tokens.map((token, i) => (
    <span key={i} style={{ color: token.color }}>
      {token.content}
    </span>
  ));
}
