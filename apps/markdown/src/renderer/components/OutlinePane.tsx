import type { ReactElement } from 'react'
import { useI18n } from '../i18n/locale'
import type { OutlineItem } from '../editor/outline'

/**
 * Document outline sidebar: heading list in document order, indented by level
 * (PDF bookmark parity). Clicking an entry jumps the editor cursor there.
 */
export function OutlinePane({
  items,
  onJump,
}: {
  items: OutlineItem[]
  onJump: (pos: number) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <aside className="md-outline" aria-label={t('outline')}>
      <div className="md-outline-title">{t('outline')}</div>
      {items.length === 0 ? (
        <div className="md-outline-empty">{t('outlineEmpty')}</div>
      ) : (
        <nav className="md-outline-list">
          {items.map((item, index) => (
            <button
              key={`${item.pos}-${index}`}
              type="button"
              className="md-outline-item"
              style={{ paddingLeft: 10 + (item.level - 1) * 14 }}
              data-tip={item.text}
              title={item.text}
              onClick={() => onJump(item.pos)}
            >
              {item.text}
            </button>
          ))}
        </nav>
      )}
    </aside>
  )
}
