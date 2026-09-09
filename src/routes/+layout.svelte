<script lang="ts">
	import { page } from '$app/stores';
	import LogoFilled from '$lib/assets/icons/logo-filled.svg';
	import { userStore } from '$lib/stores/userStore.js';
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';

	export let data;
	// Reactive, not a one-time destructure: when a load re-runs (navigation or
	// invalidate('app:credits')), these follow the fresh server data.
	$: ({ loggedIn, credits, username, subscriptionID } = data);
	$: subscriptionCancelAt = data.subscriptionCancelAt;
	let isUserMenuOpen = false;

	$: isStorybuilderPage = $page.url.pathname === '/storybuilder';
	$: isDashboardPage = $page.url.pathname === '/dashboard';

	// Server data is authoritative — re-sync the store whenever it changes.
	$: userStore.set({ credits, subscriptionID, subscriptionCancelAt, loggedIn: loggedIn || false });

	let userMenuEl: HTMLElement;

	const closeUserMenu = (event: MouseEvent): void => {
		if (userMenuEl && !userMenuEl.contains(event.target as Node)) {
			isUserMenuOpen = false;
		}
	};

	onMount(() => {
		document.addEventListener('click', closeUserMenu);

		// Returning via the browser's back/forward cache (e.g. back to Stripe and
		// forward again) restores the old DOM without re-running any load, so the
		// credit balance can be stale. Force a fresh fetch in that case.
		const handlePageShow = (e: PageTransitionEvent) => {
			if (e.persisted) invalidate('app:credits');
		};
		window.addEventListener('pageshow', handlePageShow);
		return () => {
			document.removeEventListener('click', closeUserMenu);
			window.removeEventListener('pageshow', handlePageShow);
		};
	});

	const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_INFO;
</script>

<div class="container">
	<nav>
		<div class="nav-bar">
			<a href={$userStore.loggedIn ? '/dashboard' : '/'} class="nav-logo" title="Homepage">
				<img alt="mockinterview.tech logo" src={LogoFilled} />
			</a>

			{#if $userStore.loggedIn}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div class="nav-user" bind:this={userMenuEl}>
					<button class="nav-avatar" on:click={() => isUserMenuOpen = !isUserMenuOpen}>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
							<circle cx="12" cy="7" r="4"/>
						</svg>
					</button>
					{#if isUserMenuOpen}
						<div class="nav-dropdown">
							<div class="nav-dropdown-header">
								<span class="nav-dropdown-name">{username}</span>
								<a href="/credits" class="nav-dropdown-credits" on:click={() => isUserMenuOpen = false}>Your plan</a>
							</div>
							<div class="nav-dropdown-divider"></div>
							<a href="/logout" data-sveltekit-reload on:click={() => isUserMenuOpen = false}>Log Out</a>
						</div>
					{/if}
				</div>
			{:else}
				<a href="/login" class="nav-cta">Get Started</a>
			{/if}
		</div>
	</nav>
	<main>
		<slot />
	</main>
	{#if !isStorybuilderPage && !isDashboardPage}
		<footer>
			<div class="footer-inner">
				<span>&copy; {new Date().getFullYear()} EmpowerPro Labs LLC</span>
				<span><a href="https://medium.com/@mockinterview-tech" target="_blank" rel="noopener">Blog</a></span>
				<span><a href="/legal/tos">Terms of Service</a></span>
				<span><a href="/legal/privacy">Privacy Policy</a></span>
				<span><a href="/legal/cookie">Cookie Policy</a></span>
				<span><a href="https://www.linkedin.com/in/yijunwang0402/" target="_blank" rel="noopener">LinkedIn</a></span>
			</div>
		</footer>
	{/if}
</div>

<style lang="scss">
	@import '@fontsource/inter';
	@import '../lib/styles/form.scss';
	@import '../lib/styles/button.scss';
	@import '../lib/styles/links.scss';
	@import '../lib/styles/colors.scss';

	:global(html, body) {
		width: 100%;
		height: 100%;
		padding: 0;
		margin: 0;
		overflow-x: hidden;
		background-color: $bg-warm;
		color: $text-dark;
		font-family: 'inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	:global(*) {
		font-family: inherit;
	}

	:global(.mdc-typography, .mdc-button, .mdc-card, .smui-accordion) {
		font-family: 'inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
	}

	* {
		min-width: 0;
	}

	:global(h3) {
		text-align: center;
	}
	:global(li) {
		list-style-type: none;
	}

	.container {
		font-family: 'inter', Arial, Helvetica, sans-serif;
		font-size: medium;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		width: 100%;
		padding: 0px;
		margin: 0px;
	}

	/* ── Nav ── */
	nav {
		position: fixed;
		left: 0;
		top: 0;
		width: 100%;
		z-index: 1000;
		background: rgba(255, 252, 247, 0.85);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border-bottom: 1px solid rgba(45, 43, 61, 0.06);
	}

	.nav-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 56px;
		max-width: 1200px;
		margin: 0 auto;
		padding: 0 20px;
	}

	.nav-logo {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 36px;
		text-decoration: none;
		img {
			width: 36px;
			height: 36px;
			display: block;
			position: static;
			top: auto;
			vertical-align: initial;
		}
	}

	.nav-cta {
		background: $gradient-warm;
		color: white;
		padding: 8px 22px;
		border-radius: 50px;
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
		transition: transform 0.2s, box-shadow 0.2s;
		&:hover {
			transform: translateY(-1px);
			box-shadow: 0 4px 15px rgba(232, 115, 90, 0.3);
		}
	}

	/* ── User menu ── */
	.nav-user {
		position: relative;
	}

	:global(.nav-avatar) {
		display: flex !important;
		align-items: center !important;
		justify-content: center !important;
		width: 36px !important;
		height: 36px !important;
		border-radius: 50% !important;
		border: 2px solid #e5e5e3 !important;
		background: white !important;
		color: $text-dark !important;
		cursor: pointer !important;
		padding: 0 !important;
		margin: 0 !important;
		font-size: inherit !important;
		transition: all 0.2s !important;
		&:hover {
			border-color: $primary !important;
			color: $primary !important;
			background: $bg-peach !important;
		}
	}

	.nav-dropdown {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		background: white;
		border-radius: 12px;
		box-shadow: 0 8px 30px rgba(45, 43, 61, 0.14);
		padding: 8px 0;
		min-width: 210px;
		z-index: 1001;
		animation: dropdown-in 0.15s ease-out;
	}

	.nav-dropdown-header {
		padding: 8px 20px 4px;
	}

	.nav-dropdown-name {
		display: block;
		font-weight: 700;
		font-size: 14px;
		color: $text-dark;
	}

	.nav-dropdown-credits {
		display: block;
		font-size: 12px;
		color: $text-light;
		margin-top: 2px;
	}

	.nav-dropdown-divider {
		height: 1px;
		background: #f0ece6;
		margin: 6px 0;
	}

	.nav-dropdown a {
		display: block;
		padding: 8px 20px;
		color: $text-dark;
		text-decoration: none;
		font-weight: 500;
		font-size: 14px;
		transition: background 0.15s;
		&:hover {
			background: $bg-warm;
			color: $primary;
		}
	}

	@keyframes dropdown-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	main {
		flex: 1;
	}

	footer {
		background: #3d2e24;
		color: rgba(255, 255, 255, 0.65);
		padding: 20px;

		.footer-inner {
			display: flex;
			flex-flow: row wrap;
			justify-content: center;
			max-width: 1200px;
			margin: 0 auto;
			gap: 8px;

			span {
				padding: 10px 16px;
			}
			a {
				color: rgba(255, 255, 255, 0.65);
				text-decoration: none;
				transition: color 0.2s;
				&:hover {
					color: #c96442;
				}
			}
		}
	}

	@media only screen and (max-width: 1000px) {
		* {
			font-size: 14px;
		}
		footer .footer-inner {
			justify-content: center;
			span {
				padding: 8px 10px;
			}
		}
	}
</style>
