/*
 * The React side of both catalogs: component type name → renderer. The
 * data catalog is a superset of the basic one, so a surface that names
 * either catalog renders every component.
 */
import type { ComponentType } from 'react';
import type { NodeProps } from '../runtime';
import { BASIC_COMPONENTS } from './basic';
import { Chart } from './Chart';
import { DataTable } from './DataTable';
import { DepthChart } from './DepthChart';
import { WIDGET_COMPONENTS } from './widgets';

/** Every component this renderer draws, by A2UI type name. */
export const CATALOG: Record<string, ComponentType<NodeProps>> = {
  ...BASIC_COMPONENTS,
  Chart,
  DepthChart,
  DataTable,
  ...WIDGET_COMPONENTS,
};
