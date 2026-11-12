# Document proofs in DuneOffice

A document proof is a wallet signature over the _content_ of a document. The
signer attests, in their own words — as the author, a reviewer, the approver,
or the recipient — that they stood behind this text. Anyone who later receives
the file can check two things without asking anybody and without a network:
which address signed it, and whether the content has changed since.

Review tab → **Sign**. The signing itself happens in MetaMask, in your
browser; DuneOffice never sees a key.

## What a proof claims, and what it does not

It claims:

- **Who.** An Ethereum address signed this document. Whoever controls that
  address at signing time made the claim.
- **What.** The exact content that was signed, by its digest. If a single word
  changes afterwards, verification says so.
- **In what capacity.** Author, reviewer, approver or recipient — the signer
  picks this before signing, and it is part of what they sign.

It does **not** claim:

- **When, provably — unless it has been published.** The timestamp is stated by
  the signer and signed along with everything else, so it cannot be edited
  afterwards; but nothing stops a signer writing the wrong time in the first
  place, and the card says so. Publishing the proof on-chain is what settles
  this, because a block's timestamp is not the signer's to choose. See
  "Publishing on-chain" below.
- **That the address belongs to a particular person.** An address is not an
  identity. Binding one to a name is a separate problem, and DuneOffice does
  not pretend to solve it. If you need to know that `0x7099…79C8` is a given
  colleague, you have to learn that address from them by some other route.
- **Anything on a blockchain, by default.** Signing sends no transaction, costs
  nothing and publishes nothing: the proof lives in the file. Publishing is a
  separate step you take per document, described below.

## What is covered by the digest

The point of the digest is to survive a round-trip through the editor. Saving
a `.docx` rebuilds the zip and re-serialises the XML, so the file's bytes
change even when nobody touched a word; hashing the bytes would invalidate
every signature on the first save. Instead the document is reduced to a
canonical form — what it _says_ and how it is _organised_ — and that is hashed.

Covered, so changing it breaks the proof:

- the text of every paragraph, heading, list item and table cell
- block structure and ordering, heading levels, list levels
- whether a run is struck through (deleting by strikethrough changes meaning)
- the content of embedded images, by their own hash

Not covered, so re-saving and re-styling keep the proof valid:

- visual formatting: font, size, colour, bold, italic, underline
- zip order, XML attribute order, part names, revision ids, file timestamps
- comments and tracked-change metadata — commentary about the document rather
  than the document

The dividing line is "could this change what a reader understands the document
to claim?". Strikethrough can; a colour cannot. A signer attests to the words,
not to the typography.

Text is normalised before hashing so that invisible differences cannot change
the result: Unicode is normalised to NFC, runs of whitespace of any kind
collapse to one space, and zero-width characters are dropped. Two documents
that read identically hash identically.

## Where the proof is stored

Both places, because they fail differently:

- **Embedded** in the `.docx` itself, as a custom XML part. It travels with the
  file through mail, Drive and a copy onto a USB stick.
- **A sidecar** `<document>.sig.json` next to the file. It survives a save by
  a program that drops custom XML parts, and it can be sent separately when
  the document itself must not be touched.

When both exist, the embedded proof wins — it is the one that belongs to the
bytes you are holding.

## Reading the result

The Sign button carries a dot, and the card names the state:

| State                         | What it means                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signed**                    | The signature verifies and the content matches what was signed.                                                                                      |
| **Changed since signing**     | The signature is genuine but the document has been edited since. The proof describes an earlier version. Sign it again to attest to the current one. |
| **Signature does not verify** | The stored proof is not a valid signature over this record — hand-edited, or copied from another document. Treat the document as unsigned.           |

Verification runs locally, with no network, every time the window regains
focus. That last part matters: it catches an edit made by something other than
DuneOffice, which is exactly the case a proof exists to reveal.

## Publishing on-chain

Signing proves who and what. Publishing proves _when_, and that is the only
reason to do it. The proof is written to [Base](https://base.org) as an
attestation through the
[Ethereum Attestation Service](https://attest.org), which is already deployed
there — DuneOffice has no contract of its own to trust, upgrade or lose.

Review tab → **Sign** → **Publish on Base**, on a document that is already
signed and still verifies.

What goes public: the content hash, the signer's address, the file name, the
intent and the signature. **The document itself is never uploaded** — a hash
reveals nothing about the text. The signature travels with it on purpose, so
the on-chain record stands on its own: anyone can recover the signer from the
attestation without having the file, which means a proof published by somebody
else still proves who signed.

What it costs: a network fee, paid by whoever publishes, in ETH on Base — cents,
not euros. The very first publication on a chain also registers the schema,
once, for every DuneOffice user after them.

What you cannot undo: an attestation is permanent and public. The hash does not
expose the text, but the metadata is forever — that this address signed
something at that minute, and the pattern over time. For a contract with a
counterparty that is usually the point; for internal drafts it is a reason not
to publish. EAS lets an attestation be marked revoked, which records a
withdrawal rather than erasing anything.

Once published, the card shows the block's time and a **View on-chain** link to
the attestation's public page. That link is the thing to send a recipient who
does not have DuneOffice: it shows the proof, the signer and the time, in a
browser, forever.

## How it works, in one paragraph

The content digest goes into an EIP-712 typed-data struct (`DocumentProof`:
document name, content hash, intent, signed-at, signer) under the domain
`DuneOffice Document Proof`, with no chain id — this is a claim about a
document, not a transaction on any chain. MetaMask is a browser extension and
an Electron renderer has no `window.ethereum`, so the app starts a loopback
HTTP server on 127.0.0.1 on a random port, guarded by a one-time token, and
opens a page there in the user's default browser; that page asks MetaMask to
sign and posts the signature back. The app then recovers the address from the
signature itself and checks it before storing anything. The page's claim about
which account signed is not evidence; recovery is.

## Limits today

- Only `.docx` can be signed. The canonical form is defined for word-processing
  content; spreadsheets and presentations need their own rules.
- One proof per document. Counter-signing — several people signing the same
  content — is the obvious next step and is not built yet.
- Verification is inside DuneOffice. A recipient without the app has the
  sidecar JSON and can verify it with any EIP-712 library — or, for a published
  proof, the attestation's page on easscan — but there is no standalone
  verifier to hand them.
- Publishing is Base only. The chain configuration also carries Base Sepolia for
  testing, and adding another EAS-supported chain is a few lines, but there is
  no chain picker in the UI.
