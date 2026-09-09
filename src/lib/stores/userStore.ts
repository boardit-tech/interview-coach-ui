import { writable } from 'svelte/store';

export type UserState = {
    credits: number;
    loggedIn: boolean;
}
export const userStore = writable<UserState>();
