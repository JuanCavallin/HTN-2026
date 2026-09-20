import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

export interface FlowEdgeData extends Record<string, unknown> {
  /** Work the edge feeds is happening right now. */
  active?: boolean;
  color?: string;
}

/**
 * A bezier edge that carries a small dot along it while the work it feeds is
 * running. The dot is SMIL (`animateMotion`), so it costs no JS per frame, and
 * an idle edge renders no extra elements at all.
 */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  label,
  labelStyle,
  labelBgStyle,
  data,
  interactionWidth,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const { active, color = '#6ea8fe' } = (data ?? {}) as FlowEdgeData;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelBgPadding={[4, 2]}
        labelBgBorderRadius={4}
        interactionWidth={interactionWidth}
      />
      {active && (
        <>
          <circle r={6} fill={color} opacity={0.25}>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={3} fill={color}>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      )}
    </>
  );
}
