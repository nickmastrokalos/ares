import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
import MapView from '@/views/MapView.vue'

const routes = [
  {
    path: '/',
    name: 'home',
    component: HomeView
  },
  {
    // Missions are explicit in the URL so a reload (or a deep-link from a
    // future recents list) lands back in the right mission. MapView validates
    // the id against the DB and redirects home if it's unknown.
    path: '/map/:missionId',
    name: 'map',
    component: MapView,
    props: route => ({ missionId: Number(route.params.missionId) })
  },
  {
    path: '/hub',
    name: 'hub',
    component: () => import('@/views/ControlHubView.vue')
  },
  {
    path: '/configuration',
    name: 'config',
    component: () => import('@/views/ConfigurationView.vue')
  },
  {
    path: '/scenes',
    name: 'scenes',
    component: () => import('@/views/ScenesView.vue')
  },
  {
    path: '/scenes/:sceneId',
    name: 'scene',
    component: () => import('@/views/ScenesView.vue'),
    props: route => ({ sceneId: Number(route.params.sceneId) })
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
