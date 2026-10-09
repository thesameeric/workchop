import type { AvatarConfig } from '../../../shared/types';

// The people in the landing page's office. All of them are made up.

export type ActorId = 'ama' | 'promise' | 'utibe' | 'kayode' | 'samuel' | 'sanni' | 'deji' | 'damo';

export interface Actor {
  id: ActorId;
  name: string;
  avatar: AvatarConfig;
  /** The app on their name tag. */
  app?: string;
  /** Headphones on (focus). */
  focus?: boolean;
}

function look(a: Partial<AvatarConfig> & Pick<AvatarConfig, 'skin' | 'hair' | 'hairColor' | 'top' | 'topColor' | 'bottomColor'>): AvatarConfig {
  return { shoeColor: '#f2f2f2', hat: 'none', hatColor: '#2b2d42', glasses: 'none', facialHair: 'none', ...a };
}

export const CAST: Actor[] = [
  {
    id: 'ama',
    name: 'Ama',
    app: 'notion',
    avatar: look({ skin: '#6b4029', hair: 'curly', hairColor: '#1c1410', top: 'tshirt', topColor: '#ffca3a', bottomColor: '#2b2d42', glasses: 'round' }),
  },
  {
    id: 'promise',
    name: 'Promise',
    avatar: look({ skin: '#8d5a3b', hair: 'bun', hairColor: '#1c1410', top: 'dress', topColor: '#ef476f', bottomColor: '#2b2d42', shoeColor: '#111111' }),
  },
  {
    id: 'utibe',
    name: 'Utibe',
    app: 'figma',
    avatar: look({ skin: '#f6c9a3', hair: 'long', hairColor: '#1c1410', top: 'hoodie', topColor: '#2a9d8f', bottomColor: '#2b2d42' }),
  },
  {
    id: 'kayode',
    name: 'Kayode',
    focus: true,
    avatar: look({ skin: '#4a2c1d', hair: 'short', hairColor: '#1c1410', top: 'hoodie', topColor: '#4361ee', bottomColor: '#7f8c8d', shoeColor: '#111111', facialHair: 'beard' }),
  },
  {
    id: 'samuel',
    name: 'Samuel',
    avatar: look({ skin: '#b07a4f', hair: 'short', hairColor: '#1c1410', top: 'suit', topColor: '#2b2d42', bottomColor: '#2b2d42', shoeColor: '#111111', glasses: 'round' }),
  },
  {
    // Sanni, a customer: his name tag shows what everyone but the staff sees.
    id: 'sanni',
    name: 'Visitor 14',
    avatar: look({ skin: '#e8b48f', hair: 'ponytail', hairColor: '#a86b32', top: 'tshirt', topColor: '#9b5de5', bottomColor: '#6d4c41', hat: 'cap', hatColor: '#ff924c' }),
  },
  {
    id: 'deji',
    name: 'Deji',
    avatar: look({ skin: '#d19a6a', hair: 'spiky', hairColor: '#3b2417', top: 'tshirt', topColor: '#ff924c', bottomColor: '#2b2d42', shoeColor: '#ef476f' }),
  },
  {
    id: 'damo',
    name: 'Damo',
    avatar: look({ skin: '#6b4029', hair: 'short', hairColor: '#1c1410', top: 'hoodie', topColor: '#8ac926', bottomColor: '#111111', hat: 'beanie', hatColor: '#4cc9f0' }),
  },
];
