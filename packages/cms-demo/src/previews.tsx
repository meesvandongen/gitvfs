import {
  describeDuration,
  describeRecurrence,
  formatDateRange,
  formatMoney,
  isDateRange,
  isDateTime,
  isDuration,
  phoneHref,
  type Money,
  type Recurrence,
} from 'gitvfs-cms'
import type { PreviewProps } from 'gitvfs-cms/react'

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' && value ? value : fallback)

// Custom previews replace the rendered tab per collection: <CmsApp previews={{ authors: AuthorPreview }} />.
// They render in the editor's page, so only show trusted values (React escapes text for you).

export function AuthorPreview({ values }: PreviewProps) {
  const name = typeof values.name === 'string' && values.name ? values.name : 'Unnamed author'
  const color = typeof values.color === 'string' ? values.color : '#2f6feb'
  const socials = Array.isArray(values.socials) ? (values.socials as Array<{ network?: string; url?: string }>) : []
  return (
    <div className="demo-preview">
      <article className="demo-author" style={{ borderTopColor: color }}>
        <div className="demo-avatar" style={{ background: color }} aria-hidden>
          {name.slice(0, 1)}
        </div>
        <h2>{name}</h2>
        <p className="demo-role">{text(values.role)}</p>
        {typeof values.bio === 'string' && values.bio ? <p>{values.bio}</p> : null}
        <ul>
          {socials.filter((social) => social?.url).map((social, index) => (
            <li key={index}>
              {social.network}: {social.url}
            </li>
          ))}
        </ul>
      </article>
    </div>
  )
}

export function EventPreview({ values }: PreviewProps) {
  const tickets = Array.isArray(values.tickets) ? (values.tickets as Array<{ name?: string; price?: number }>) : []
  const location = values.location as { venue?: string; city?: string } | undefined
  const repeats = values.repeats as Recurrence | null | undefined
  const starts = values.starts instanceof Date || typeof values.starts === 'string' ? new Date(values.starts) : null
  return (
    <div className="demo-preview">
      <article className="demo-event">
        <p className="demo-role">{starts && !Number.isNaN(starts.getTime()) ? starts.toDateString() : 'No date yet'}</p>
        <h2>{text(values.title, 'Untitled event')}</h2>
        <p>{values.online ? 'Online' : [location?.venue, location?.city].filter(Boolean).join(', ') || 'Location to be announced'}</p>
        {isDateRange(values.dates) ? <p>{formatDateRange(values.dates, 'en-GB')}</p> : null}
        {repeats ? <p>{describeRecurrence(repeats, { locale: 'en-GB' })}</p> : null}
        {tickets.length > 0 ? (
          <table>
            <tbody>
              {tickets.map((ticket, index) => (
                <tr key={index}>
                  <td>{ticket?.name}</td>
                  <td>{typeof ticket?.price === 'number' ? (ticket.price === 0 ? 'Free' : `€${ticket.price}`) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </article>
    </div>
  )
}

/** What a site would do with the stored formats, using the helpers from `gitvfs-cms`. */
export function ShowPreview({ values }: PreviewProps) {
  const price = values.price as Partial<Money> | undefined
  const starts = isDateTime(values.starts)
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(values.starts))
    : 'Date to be announced'
  return (
    <div className="demo-preview">
      <article className="demo-event">
        <p className="demo-role">{starts}</p>
        <h2>{text(values.title, 'Untitled show')}</h2>
        <p>
          {typeof values.doors === 'string' && values.doors ? `Doors ${values.doors}. ` : ''}
          {isDuration(values.runtime) ? `Running time ${describeDuration(values.runtime, 'en')}` : ''}
          {isDuration(values.intermission) ? `, plus an intermission of ${describeDuration(values.intermission, 'en')}` : ''}.
        </p>
        <table>
          <tbody>
            <tr>
              <td>Tickets</td>
              <td>{typeof price?.amount === 'number' && price.currency ? formatMoney(price as Money, 'en') : ''}</td>
            </tr>
            <tr>
              <td>On sale</td>
              <td>{typeof values.onSale === 'number' ? `${values.onSale}% of seats` : ''}</td>
            </tr>
          </tbody>
        </table>
        {typeof values.boxOffice === 'string' && values.boxOffice ? (
          <p>
            Box office: <a href={phoneHref(values.boxOffice)}>{values.boxOffice}</a>
          </p>
        ) : null}
      </article>
    </div>
  )
}
