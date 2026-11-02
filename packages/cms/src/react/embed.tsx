import { useState } from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import { parseEmbedUrl } from '../media.js'
import { useFieldBinding as useField } from './field-utils.js'

const PROVIDERS = {
  youtube: { name: 'YouTube', host: 'youtube-nocookie.com' },
  vimeo: { name: 'Vimeo', host: 'player.vimeo.com' },
} as const

function formatStart(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * A video or other link, stored as the URL. YouTube and Vimeo links get a player, which loads only
 * after a click (nothing is requested from those sites before), from youtube-nocookie.com or with
 * Vimeo's do-not-track flag.
 */
export function EmbedField({ id, inputProps, label }: AutoFormFieldProps) {
  const field = useField(id)
  const value = typeof field.value === 'string' ? field.value : ''
  const info = value ? parseEmbedUrl(value) : undefined
  const [loaded, setLoaded] = useState<string>()
  const provider = info && info.provider !== 'url' ? PROVIDERS[info.provider] : undefined

  return (
    <div className="gcms-embed">
      <input
        type="url"
        className="gcms-input"
        inputMode="url"
        autoComplete="off"
        placeholder="https://www.youtube.com/watch?v=…"
        {...inputProps}
        id={id}
        name={field.name}
        ref={field.ref}
        value={value}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
      />
      {info?.embedUrl && provider ? (
        loaded === info.embedUrl ? (
          <div className="gcms-embed-frame">
            <iframe
              src={info.embedUrl}
              title={`${provider.name} video${typeof label === 'string' && label ? `: ${label}` : ''}`}
              // The player is another origin; it needs scripts, and its own origin for its storage.
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              allow="encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
            />
          </div>
        ) : (
          <div className="gcms-embed-card">
            <p>
              <strong>{provider.name}</strong> video <code>{info.id}</code>
              {info.start ? ` from ${formatStart(info.start)}` : ''}
            </p>
            <button type="button" className="gcms-button gcms-button--small" onClick={() => setLoaded(info.embedUrl)}>
              Load preview
            </button>
            <p className="gcms-muted">Loads the player from {provider.host}.</p>
          </div>
        )
      ) : info?.provider === 'url' ? (
        <p className="gcms-muted">
          A link without a preview.{' '}
          <a href={info.url} target="_blank" rel="noreferrer noopener">
            Open it
          </a>
        </p>
      ) : null}
    </div>
  )
}
