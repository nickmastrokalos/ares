import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import { createVuetify } from 'vuetify'

const aresDark = {
  dark: true,
  colors: {
    background: '#0d0d0d',
    surface: '#161616',
    'surface-light': '#1e1e1e',
    'surface-variant': '#252525',
    'on-background': '#e0e0e0',
    'on-surface': '#e0e0e0',
    'surface-bright': '#2a2a2a',
    'on-surface-bright': '#e0e0e0',
    tooltip: '#2a2a2a',
    primary: '#4a9ade',
    'on-primary': '#ffffff',
    secondary: '#888888',
    error: '#e54545',
    info: '#4a9ade',
    success: '#45b55e',
    warning: '#e5a545',
  }
}

export default createVuetify({
  theme: {
    defaultTheme: 'aresDark',
    themes: { aresDark }
  },
  defaults: {
    VBtn: {
      variant: 'text',
      rounded: 'sm',
      ripple: false
    },
    VCard: {
      rounded: 'sm',
      flat: true,
      color: 'surface'
    },
    VTextField: {
      variant: 'outlined',
      density: 'compact',
      rounded: 'sm',
      hideDetails: 'auto',
      color: 'primary'
    },
    VSelect: {
      variant: 'outlined',
      density: 'compact',
      rounded: 'sm',
      hideDetails: 'auto',
      color: 'primary'
    },
    VChip: {
      rounded: 'sm',
      variant: 'outlined',
      size: 'small'
    },
    VDivider: {
      color: 'surface-variant'
    },
    VToolbar: {
      flat: true,
      color: 'surface',
      density: 'compact'
    },
    VList: {
      bgColor: 'transparent'
    },
    VListItem: {
      rounded: 'sm'
    },
    VTooltip: {
      location: 'bottom'
    },
    VNavigationDrawer: {
      color: 'surface'
    }
  }
})
