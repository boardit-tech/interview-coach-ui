<script lang="ts">
	import { userStore } from '$lib/stores/userStore';
	import { tz } from '$lib/stores/tz';

	export let data;

	const offerings = data.offerings;
	$: plan = data.plan ?? [];
	$: active = plan.filter(p => !p.expired && !p.revoked);
	$: past = plan.filter(p => p.expired || p.revoked);
	$: credits = data.credits ?? 0;

	const submit = (id: string) => {
		const form = document.getElementById(id);
		if (form instanceof HTMLFormElement) form.submit();
	};

	const fmtDate = (iso: string, zone?: string) =>
		new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: zone });
	const kindLabel = (p: any) =>
		p.kind === 'bundle' ? '60-day story bundle'
		: p.kind === 'finish_story' ? 'Finish this story'
		: p.source === 'trial' ? 'Welcome story'
		: 'Single story';
	const usage = (p: any) =>
		p.kind === 'finish_story' ? '' : `${p.used} of ${p.storiesAllowed} used`;
</script>

<div class="credits-page">
	<div class="credits-back-row">
		<a href="/dashboard" class="credits-back">&larr; Dashboard</a>
	</div>
	<div class="credits-inner">

		{#if data.finishStory}
			<!-- Reached only from an expired in-progress story. -->
			<div class="credits-header">
				<h1>Finish this story</h1>
				<p class="credits-subtitle">Its build window has ended. Reopen it for another 30 days and pick up right where you left off.</p>
			</div>
			<div class="credits-cards credits-cards-single">
				<button class="credits-card credits-card-featured" on:click={() => submit('finish')}>
					<form id="finish" action="?/purchase" method="POST">
						<input type="hidden" name="kind" value="finish_story" />
						<input type="hidden" name="forStoryId" value={data.finishStory.id} />
					</form>
					<div class="credits-card-top">
						<h2>{data.finishOffering.label}</h2>
						<p class="credits-desc" class:untitled={!data.finishStory.question}>
							{data.finishStory.question || 'Untitled story'}
						</p>
					</div>
					<div class="credits-price">
						<span class="credits-amount">${data.finishOffering.price}</span>
					</div>
					<div class="credits-divider"></div>
					<ul class="credits-features">
						{#each data.finishOffering.features as feature}
							<li><span class="credits-check">✓</span> {feature}</li>
						{/each}
						<li><span class="credits-check">✓</span> Everything already built stays exactly as it is</li>
					</ul>
					<div class="credits-card-cta">Reopen for ${data.finishOffering.price}</div>
				</button>
			</div>
			<p class="credits-fineprint">Non-refundable. By placing the order, you agree to the terms of service.</p>

		{:else}

			<div class="credits-header">
				<h1>Your plan</h1>
				{#if active.length === 0 && credits === 0}
					<p class="credits-subtitle">No stories on your plan right now. Pick one below to start building.</p>
				{:else}
					<p class="credits-subtitle">Everything you can build with, and when each window ends.</p>
				{/if}
			</div>

			{#if active.length > 0 || credits > 0}
				<div class="credits-plan">
					{#each active as p}
						<div class="credits-plan-row">
							<div>
								<span class="credits-plan-kind">{kindLabel(p)}</span>
								{#if usage(p)}<span class="credits-plan-usage">{usage(p)}</span>{/if}
							</div>
							<span class="credits-plan-ends">ends {fmtDate(p.expiresAt, $tz)}</span>
						</div>
					{/each}
					{#if credits > 0}
						<div class="credits-plan-row">
							<div>
								<span class="credits-plan-kind">Session credits</span>
								<span class="credits-plan-usage">{credits} left · one credit starts one story</span>
							</div>
							<span class="credits-plan-ends">no expiry</span>
						</div>
					{/if}
				</div>
			{/if}

			<div class="credits-header credits-header-more">
				<h2>Get more stories</h2>
				<p class="credits-subtitle">Every plan has a window on purpose: you buy at your motivation peak, and a deadline keeps it there. Stories you finish are yours forever.</p>
			</div>
			<div class="credits-cards">
				{#each offerings as offering}
					<button class="credits-card" class:credits-card-featured={offering.kind === 'bundle'} on:click={() => submit(offering.kind)}>
						<form id={offering.kind} action="?/purchase" method="POST">
							<input type="hidden" name="kind" value={offering.kind} />
						</form>
						{#if offering.compareAt}
							<span class="credits-badge">Early bird</span>
						{/if}
						<div class="credits-card-top">
							<h2>{offering.label}</h2>
							<p class="credits-desc">{offering.description}</p>
						</div>
						<div class="credits-price">
							{#if offering.compareAt}
								<span class="credits-compare">${offering.compareAt}</span>
							{/if}
							<span class="credits-amount">${offering.price}</span>
						</div>
						<div class="credits-divider"></div>
						<ul class="credits-features">
							{#each offering.features as feature}
								<li><span class="credits-check">✓</span> {feature}</li>
							{/each}
						</ul>
						<div class="credits-card-cta">Buy now</div>
					</button>
				{/each}
			</div>
			<p class="credits-fineprint">Windows count from the day of purchase. Non-refundable. By placing the order, you agree to the terms of service.</p>

			{#if past.length > 0}
				<details class="credits-past">
					<summary>Past purchases</summary>
					{#each past as p}
						<div class="credits-plan-row credits-plan-row-past">
							<div>
								<span class="credits-plan-kind">{kindLabel(p)}</span>
								{#if usage(p)}<span class="credits-plan-usage">{usage(p)}</span>{/if}
							</div>
							<span class="credits-plan-ends">{p.revoked ? 'refunded' : `ended ${fmtDate(p.expiresAt, $tz)}`}</span>
						</div>
					{/each}
				</details>
			{/if}
		{/if}
	</div>
</div>

<style lang="scss">
	@import '$lib/styles/colors.scss';

	.credits-page {
		min-height: 100vh;
		background: $bg-warm;
	}

	.credits-back-row {
		max-width: 1200px;
		margin: 0 auto;
		padding: 68px 20px 0;
	}

	.credits-inner {
		max-width: 900px;
		margin: 0 auto;
		padding: 32px 24px 60px;
	}

	.credits-back {
		display: inline-block;
		padding: 10px 24px;
		font-size: 0.9rem;
		font-weight: 600;
		color: #c96442;
		text-decoration: none;
		border: 1px solid #c96442;
		border-radius: 24px;
		transition: all 0.2s;
		margin-bottom: 32px;
		&:hover {
			background: #c96442;
			color: white;
		}
	}

	.credits-header h1 {
		font-size: 1.8rem;
		font-weight: 700;
		color: $text-dark;
		margin: 0 0 8px;
	}
	.credits-subtitle {
		color: $text-light;
		font-size: 1rem;
		margin: 0;
	}

	.credits-cards {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 24px;
		margin-top: 8px;
	}
	.credits-compare {
		font-size: 1.4rem;
		color: #aaa;
		text-decoration: line-through;
		margin-right: 10px;
		vertical-align: baseline;
	}
	.credits-cards-single {
		grid-template-columns: minmax(0, 460px);
		justify-content: center;
	}
	.credits-header-more {
		margin-top: 40px;
		margin-bottom: 16px;
		h2 { font-size: 1.25rem; font-weight: 700; color: $text-dark; margin: 0 0 6px; }
	}
	.credits-active { margin-bottom: 32px; }
	.credits-plan {
		background: white;
		border: 1px solid #f3d9c9;
		border-radius: 14px;
		padding: 4px 20px;
		margin-top: 16px;
	}
	.credits-plan-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		padding: 14px 0;
		border-bottom: 1px solid #f0ece6;
		&:last-child { border-bottom: none; }
	}
	.credits-plan-row-past { opacity: 0.7; }
	.credits-plan-kind { display: block; font-weight: 600; color: $text-dark; }
	.credits-plan-usage { display: block; font-size: 0.85rem; color: $text-light; margin-top: 2px; }
	.credits-plan-ends { font-size: 0.85rem; color: $text-light; white-space: nowrap; }
	.credits-fineprint { font-size: 0.8rem; color: #999; margin: 16px 0 0; text-align: center; }
	.credits-past {
		margin-top: 32px;
		summary { cursor: pointer; font-size: 0.9rem; color: $text-light; }
		.credits-plan-row { padding: 10px 0; }
	}
	.credits-desc.untitled { font-style: italic; color: #999; }

	.credits-card {
		position: relative;
		background: white;
		border-radius: 20px;
		padding: 36px 32px;
		box-shadow: $card-shadow;
		border: 2px solid transparent;
		cursor: pointer;
		text-align: center;
		transition: all 0.25s;
		display: flex;
		flex-direction: column;
		align-items: center;
		&:hover {
			border-color: #c96442;
			box-shadow: $card-shadow-hover;
			transform: translateY(-3px);
		}
	}
	.credits-card-featured {
		border-color: #c96442;
		background: linear-gradient(180deg, #fff8f4 0%, #ffffff 55%);
		box-shadow: 0 14px 34px rgba(201, 100, 66, 0.16);
		transform: translateY(-6px);
		&:hover {
			border-color: #c96442;
			transform: translateY(-10px);
			box-shadow: 0 20px 40px rgba(201, 100, 66, 0.22);
		}
	}

	.credits-card-top {
		margin-bottom: 4px;
	}

	.credits-card h2 {
		font-size: 1.25rem;
		font-weight: 700;
		color: $text-dark;
		margin: 12px 0 8px;
	}

	.credits-desc {
		color: $text-light;
		font-size: 0.88rem;
		line-height: 1.5;
		margin: 0;
		min-height: 2.8em;
	}

	.credits-price {
		margin: 16px 0;
	}
	.credits-amount {
		font-size: 2.8rem;
		font-weight: 800;
		color: $text-dark;
		letter-spacing: -0.02em;
	}
	.credits-period {
		font-size: 0.95rem;
		color: $text-light;
		margin-left: 2px;
	}

	.credits-divider {
		width: 48px;
		height: 2px;
		background: #f0ece6;
		border-radius: 1px;
		margin-bottom: 20px;
	}

	.credits-features {
		list-style: none;
		padding: 0;
		margin: 0 0 20px;
		text-align: left;
		width: 100%;
		li {
			font-size: 0.9rem;
			color: $text-medium;
			padding: 6px 0;
			display: flex;
			align-items: flex-start;
			gap: 10px;
		}
	}
	.credits-check {
		color: #2e7d32;
		font-weight: 700;
		font-size: 0.85rem;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.credits-badge {
		position: absolute;
		top: -13px;
		left: 50%;
		transform: translateX(-50%);
		background: #c96442;
		color: white;
		font-size: 0.72rem;
		font-weight: 700;
		padding: 6px 16px;
		border-radius: 14px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		white-space: nowrap;
		box-shadow: 0 4px 12px rgba(201, 100, 66, 0.3);
	}

	.credits-cancel-note {
		font-size: 0.78rem;
		color: $text-light;
		line-height: 1.5;
		margin: 0 0 16px;
		text-align: center;
	}

	.credits-card-cta {
		margin-top: auto;
		padding: 12px 36px;
		background: #c96442;
		color: white;
		font-size: 0.95rem;
		font-weight: 600;
		border-radius: 24px;
		transition: background 0.2s;
	}
	.credits-card:hover .credits-card-cta {
		background: #b5593a;
	}

	.credits-active {
		background: white;
		border-radius: 12px;
		padding: 20px 24px;
		box-shadow: $card-shadow;
		margin-top: 24px;
	}
	.credits-active-top {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 0.95rem;
		font-weight: 600;
		color: $text-dark;
	}
	.credits-renew {
		display: block;
		margin-top: 8px;
		font-size: 0.84rem;
		color: $text-light;
	}
	.credits-active-badge {
		background: #e8f5e9;
		color: #2e7d32;
		font-size: 0.75rem;
		font-weight: 700;
		padding: 4px 10px;
		border-radius: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.credits-manage-link {
		display: inline-block;
		margin-top: 16px;
		font-size: 0.82rem;
		color: #aaa;
		font-weight: 400;
		text-decoration: none;
		&:hover {
			color: #888;
			text-decoration: underline;
		}
	}

	@media (max-width: 650px) {
		.credits-cards {
			grid-template-columns: 1fr;
			max-width: 380px;
			margin-left: auto;
			margin-right: auto;
		}
		.credits-header h1 {
			font-size: 1.5rem;
		}
	}
</style>
