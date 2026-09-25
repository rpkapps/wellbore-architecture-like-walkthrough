import './styles.css';
import { createRoot } from 'react-dom/client';
import { installAutoTitle } from './ui/autoTitle';
import { Root } from './ui/shell/Root';

installAutoTitle();
createRoot(document.getElementById('app')!).render(<Root />);
