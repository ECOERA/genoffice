/**
 * Tod — a sandworm bent into a paperclip.
 *
 * The body is one stroked path tracing a gem-clip wire: inner leg, bend over
 * the top, down the outer right, round the bottom, up the outer left, then the
 * free end crests and rears into a neck carrying the head. The worm's segment
 * rings are sampled from that same wire (tod-geometry.ts), so the ribbing
 * follows the clip exactly and the two readings never come apart. The bottom
 * bend dips into a sand mound drawn over it.
 *
 * Colors come from the --tod-* custom properties in tod.css, defined per
 * theme, so Tod follows the UI theme like the rest of the chrome.
 */
import React from 'react'
import { BODY_PATH, BODY_RING_COUNT, HEAD_POS, SAND_TOP, bodyRings } from './tod-geometry'

const RINGS = bodyRings(BODY_RING_COUNT)

/** teeth ring inside the maw */
const TEETH = Array.from({ length: 11 }, (_, i) => {
  const a = (i / 11) * Math.PI * 2 - Math.PI / 2
  return {
    x1: +(Math.cos(a) * 8.8).toFixed(2),
    y1: +(1.4 + Math.sin(a) * 8.4).toFixed(2),
    x2: +(Math.cos(a) * 6).toFixed(2),
    y2: +(1.6 + Math.sin(a) * 5.7).toFixed(2),
  }
})

/** what Tod is doing; drives the CSS animations in tod.css */
export type TodPose = 'idle' | 'talking' | 'alert'

export interface TodArtProps {
  /** rendered height in px; the width follows the artwork's aspect ratio */
  readonly size?: number
  readonly pose?: TodPose
  /** hides the sand mound — the small restore handle reads as clutter with it */
  readonly grounded?: boolean
}

export function TodArt({ size = 84, pose = 'idle', grounded = true }: TodArtProps) {
  // the maw opens while he is saying something, and wider when he is insistent
  const maw = pose === 'idle' ? 9.4 : pose === 'talking' ? 10.4 : 11
  const gullet = pose === 'idle' ? 5.8 : pose === 'talking' ? 7 : 7.6
  return (
    <svg
      className={`tod-art tod-art-${pose}`}
      width={size * 0.84}
      height={size}
      viewBox="14 4 104 124"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {grounded && (
        <ellipse
          className="tod-shadow"
          cx="64"
          cy={SAND_TOP + 12}
          rx="46"
          ry="9"
          fill="var(--tod-sand)"
        />
      )}
      {/* the worm sways from its base, so everything above the sand moves together */}
      <g className="tod-sway">
        <path
          d={BODY_PATH}
          stroke="var(--tod-skin-dark)"
          strokeWidth="15.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={BODY_PATH}
          stroke="var(--tod-skin)"
          strokeWidth="12.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <g className="tod-segments">
          {RINGS.map(([x1, y1, x2, y2], i) => (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--tod-skin-dark)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.5"
            />
          ))}
        </g>
        {/* Positioning and animation must live on separate groups: a CSS
         * `transform` animation replaces the SVG transform attribute outright,
         * so animating this group directly would drop it back to the origin. */}
        <g transform={`translate(${HEAD_POS[0]} ${HEAD_POS[1]})`}>
          <g className="tod-head">
            <ellipse
              cx="0"
              cy="0"
              rx="15"
              ry="14.5"
              fill="var(--tod-skin)"
              stroke="var(--tod-skin-dark)"
              strokeWidth="1.6"
            />
            <ellipse cx="-4" cy="-4" rx="8" ry="7" fill="var(--tod-skin-light)" opacity="0.35" />
            <ellipse
              className="tod-maw"
              cx="0"
              cy="1.5"
              rx={maw}
              ry={maw - 0.4}
              fill="var(--tod-maw)"
            />
            <ellipse cx="0" cy="2" rx={gullet} ry={gullet - 0.4} fill="var(--tod-maw-inner)" />
            {TEETH.map((tooth, i) => (
              <line
                key={i}
                x1={tooth.x1}
                y1={tooth.y1}
                x2={tooth.x2}
                y2={tooth.y2}
                stroke="var(--tod-skin-light)"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            ))}
            <g className="tod-eyes">
              <ellipse
                cx="-6.3"
                cy="-9.4"
                rx="4.3"
                ry="4.7"
                fill="var(--tod-eye-white)"
                stroke="var(--tod-skin-dark)"
                strokeWidth="1"
              />
              <ellipse
                cx="6.3"
                cy="-9.4"
                rx="4.3"
                ry="4.7"
                fill="var(--tod-eye-white)"
                stroke="var(--tod-skin-dark)"
                strokeWidth="1"
              />
              <circle cx="-5.5" cy="-8.9" r="2.1" fill="var(--tod-pupil)" />
              <circle cx="7.1" cy="-8.9" r="2.1" fill="var(--tod-pupil)" />
              <circle cx="-4.8" cy="-9.8" r="0.8" fill="var(--tod-eye-white)" />
              <circle cx="7.8" cy="-9.8" r="0.8" fill="var(--tod-eye-white)" />
            </g>
            <g className="tod-brows">
              <path
                d="M -10.6 -15 Q -6.3 -17.6 -2.3 -15.4"
                stroke="var(--tod-skin-dark)"
                strokeWidth="1.7"
                fill="none"
                strokeLinecap="round"
              />
              <path
                d="M 2.3 -15.4 Q 6.3 -17.6 10.6 -15"
                stroke="var(--tod-skin-dark)"
                strokeWidth="1.7"
                fill="none"
                strokeLinecap="round"
              />
            </g>
          </g>
        </g>
      </g>
      {grounded && (
        <g className="tod-sand">
          <path
            d={`M 18 ${SAND_TOP + 14} Q 34 ${SAND_TOP} 52 ${SAND_TOP + 4} Q 74 ${SAND_TOP - 3} 92 ${SAND_TOP + 2} Q 104 ${SAND_TOP + 5} 112 ${SAND_TOP + 14} Z`}
            fill="var(--tod-sand)"
          />
          <path
            d={`M 28 ${SAND_TOP + 10} Q 42 ${SAND_TOP + 3} 54 ${SAND_TOP + 7}`}
            stroke="var(--tod-sand-dark)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M 72 ${SAND_TOP + 3} Q 86 ${SAND_TOP + 1} 98 ${SAND_TOP + 8}`}
            stroke="var(--tod-sand-dark)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M 34 ${SAND_TOP + 7} Q 45 ${SAND_TOP + 2} 53 ${SAND_TOP + 5}`}
            stroke="var(--tod-sand-light)"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
            opacity="0.85"
          />
        </g>
      )}
    </svg>
  )
}
