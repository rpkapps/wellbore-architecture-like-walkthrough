import { Button } from '@tecton/react/components/button';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import type { ComponentProps, ReactNode } from 'react';

type ButtonProps = ComponentProps<typeof Button>;

/** Icon-only button: named by `label`, which is also its tooltip. */
export function IconButton({
  label,
  children,
  variant = 'ghost',
  size = 'icon-sm',
  placement = 'bottom',
  ...props
}: Omit<ButtonProps, 'children' | 'aria-label'> & { label: string; children: ReactNode; placement?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipTrigger delay={400}>
      <Button variant={variant} size={size} aria-label={label} {...props}>
        {children}
      </Button>
      <Tooltip placement={placement}>{label}</Tooltip>
    </TooltipTrigger>
  );
}
