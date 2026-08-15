import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { BUILD } from '$lib/build';

/** Unauthenticated on purpose: it's the first thing to curl when something's off. */
export const GET: RequestHandler = async () => json(BUILD);
