import { SEVERITY_LABELS, type Severity } from '../api/types';

interface Props {
  severity: Severity;
}

/**
 * Vakavuusmerkki: pieni värillinen piste rivin otsikon edessä.
 *
 * Tooltip (natiivinen `title`) ja `aria-label` kertovat vakavuuden myös
 * sanallisesti, joten pelkkä väri ei ole ainoa tiedon välittäjä.
 */
export function SeverityDot({ severity }: Props) {
  const text = `Vakavuus: ${SEVERITY_LABELS[severity] ?? severity}`;

  return (
    <span
      className={`severity-dot severity-dot--${severity.toLowerCase()}`}
      title={text}
      aria-label={text}
      role="img"
    />
  );
}
