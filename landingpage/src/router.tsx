import {
	createRouter,
	createRootRoute,
	createRoute,
	Outlet,
	Link,
	useNavigate,
} from "@tanstack/react-router";
import React, { useState } from "react";
import HeroSection from "./components/HeroSection";
import FeatureSection from "./components/FeatureSection";
import BenchmarkPage from "./components/BenchmarkPage";
import DocsPage from "./components/DocsPage";
import NewLandingPage from "./components/LandingPage";

// Root layout with navigation
const RootLayout: React.FC = () => {
	return (
		<div className="min-h-screen bg-[#0f0f0f] text-white selection:bg-claude-ish selection:text-black font-sans scroll-smooth">
			{/* Dynamic Nav */}
			<nav className="fixed top-0 left-0 right-0 z-[100] bg-[#0f0f0f]/90 border-b border-white/5 backdrop-blur-xl">
				<div className="max-w-7xl mx-auto px-8 h-20 flex items-center justify-between">
					<Link
						to="/"
						className="text-white font-mono font-black text-2xl tracking-tighter flex items-center gap-3 focus:outline-none hover:opacity-80 transition-opacity"
					>
						<div className="w-8 h-8 bg-claude-ish rounded flex items-center justify-center text-[14px] text-black">
							M
						</div>
						claudemem
					</Link>
					<div className="hidden md:flex items-center gap-10 text-[11px] font-mono text-gray-500 uppercase tracking-[0.2em] font-black">
						<Link
							to="/benchmarks"
							className="hover:text-claude-ish transition-colors focus:outline-none [&.active]:text-white"
						>
							Benchmarks
						</Link>
						<Link
							to="/docs"
							className="hover:text-claude-ish transition-colors focus:outline-none [&.active]:text-white"
						>
							Docs
						</Link>
						<a
							href="https://github.com/MadAppGang/claudemem"
							target="_blank"
							rel="noreferrer"
							className="group flex items-center gap-2 bg-white/5 px-5 py-2.5 border border-white/10 rounded-full hover:bg-white/10 hover:border-white/30 transition-all text-white"
						>
							<svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.744.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
							GitHub
						</a>
					</div>
				</div>
			</nav>

			<main>
				<Outlet />
			</main>

			{/* Footer */}
			<Footer />
		</div>
	);
};

// Footer component
const Footer: React.FC = () => {
	return (
		<footer className="py-40 bg-[#050505] border-t border-white/5 relative overflow-hidden">
			<div className="max-w-7xl mx-auto px-8">
				<div className="grid lg:grid-cols-3 gap-20 mb-32">
					<div className="space-y-8">
						<div className="text-white font-mono font-black text-2xl tracking-tighter flex items-center gap-3">
							<div className="w-8 h-8 bg-claude-ish rounded flex items-center justify-center text-[14px] text-black">
								M
							</div>
							claudemem
						</div>
						<p className="text-gray-500 text-sm leading-relaxed font-mono">
							Local-first semantic code intelligence. No cloud, no vendor
							lock-in, just deep understanding for your AI agents.
						</p>
						<div className="flex gap-4">
							<a
								href="#"
								className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
							>
								<svg
									className="w-5 h-5"
									fill="currentColor"
									viewBox="0 0 24 24"
								>
									<path d="M24 4.557c-.883.392-1.832.656-2.828.775 1.017-.609 1.798-1.574 2.165-2.724-.951.564-2.005.974-3.127 1.195-.897-.957-2.178-1.555-3.594-1.555-3.179 0-5.515 2.966-4.797 6.045-4.091-.205-7.719-2.165-10.148-5.144-1.29 2.213-.669 5.108 1.523 6.574-.806-.026-1.566-.247-2.229-.616-.054 2.281 1.581 4.415 3.949 4.89-.693.188-1.452.232-2.224.084.626 1.956 2.444 3.379 4.6 3.419-2.07 1.623-4.678 2.348-7.29 2.04 2.179 1.397 4.768 2.212 7.548 2.212 9.142 0 14.307-7.721 13.995-14.646.962-.695 1.797-1.562 2.457-2.549z" />
								</svg>
							</a>
							<a
								href="#"
								className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
							>
								<svg
									className="w-5 h-5"
									fill="currentColor"
									viewBox="0 0 24 24"
								>
									<path d="M12 0c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12zm-2 16h-2v-6h2v6zm-1-6.891c-.607 0-1.1-.493-1.1-1.1s.493-1.1 1.1-1.1 1.1.493 1.1 1.1-.493 1.1-1.1 1.1zm9 6.891h-2v-3.868c0-1.935-2.344-1.789-2.344 0v3.868h-2v-6h2v1.132c.901-1.665 4.344-1.789 4.344 1.568v3.3zm-14-11h-2v11h2v-11z" />
								</svg>
							</a>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-10">
						<div className="space-y-6">
							<h4 className="text-white font-bold uppercase tracking-widest text-[11px]">
								Product
							</h4>
							<ul className="space-y-4 text-sm text-gray-500 font-mono">
								<li>
									<Link
										to="/docs"
										className="hover:text-claude-ish transition-colors"
									>
										Documentation
									</Link>
								</li>
								<li>
									<Link
										to="/docs/$section"
										params={{ section: "cli" }}
										className="hover:text-claude-ish transition-colors"
									>
										CLI reference
									</Link>
								</li>
								<li>
									<Link
										to="/benchmarks"
										className="hover:text-claude-ish transition-colors"
									>
										Benchmarks
									</Link>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-claude-ish transition-colors"
									>
										Roadmap
									</a>
								</li>
							</ul>
						</div>
						<div className="space-y-6">
							<h4 className="text-white font-bold uppercase tracking-widest text-[11px]">
								Open Source
							</h4>
							<ul className="space-y-4 text-sm text-gray-500 font-mono">
								<li>
									<a
										href="#"
										className="hover:text-claude-ish transition-colors"
									>
										MIT License
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-claude-ish transition-colors"
									>
										Contributing
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-claude-ish transition-colors"
									>
										Community
									</a>
								</li>
								<li>
									<a
										href="#"
										className="hover:text-claude-ish transition-colors"
									>
										Sponsor
									</a>
								</li>
							</ul>
						</div>
					</div>

					<div className="space-y-8 bg-[#0a0a0a] p-10 rounded-3xl border border-white/5">
						<h4 className="text-white font-bold uppercase tracking-widest text-xs">
							Research Acknowledgements
						</h4>
						<p className="text-gray-500 text-xs leading-relaxed font-mono">
							claudemem is built on the shoulders of giants. We are grateful to
							the authors of the Meta-RAG study (JP Morgan 2025), the Aider repo
							map architecture, and the tree-sitter team.
						</p>
						<div className="text-[10px] text-claude-ish font-black tracking-widest uppercase">
							Brokk's depth + claude-context's accessibility
						</div>
					</div>
				</div>

				<div className="pt-20 border-t border-gray-900 flex flex-col md:flex-row justify-between items-center gap-8">
					<div className="text-[10px] text-gray-700 uppercase tracking-[0.5em] font-mono">
						© 2025 • Made with research and care
					</div>
					<div className="flex gap-10 text-[10px] text-gray-600 font-mono uppercase tracking-widest font-black">
						<a href="#" className="hover:text-white transition-colors">
							Privacy
						</a>
						<a href="#" className="hover:text-white transition-colors">
							Security
						</a>
						<a href="#" className="hover:text-white transition-colors">
							Terms
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
};

// Landing page component with toggle between old and new versions
const LandingPage: React.FC = () => {
	const navigate = useNavigate();
	const [showNewVersion, setShowNewVersion] = useState(true);

	if (showNewVersion) {
		return (
			<>
				<NewLandingPage />
				{/* Toggle to old version */}
				<div className="fixed bottom-4 right-4 z-50">
					<button
						onClick={() => setShowNewVersion(false)}
						className="bg-gray-800 text-gray-400 text-xs px-3 py-2 rounded-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors"
					>
						View Old Version
					</button>
				</div>
			</>
		);
	}

	return (
		<>
			<HeroSection
				onNavigateToBenchmarks={() => navigate({ to: "/benchmarks" })}
				onNavigateToDocs={() => navigate({ to: "/docs" })}
			/>
			<FeatureSection />
			{/* Toggle to new version */}
			<div className="fixed bottom-4 right-4 z-50">
				<button
					onClick={() => setShowNewVersion(true)}
					className="bg-[#00d4aa] text-black text-xs font-bold px-3 py-2 rounded-lg hover:bg-[#00d4aa]/90 transition-colors"
				>
					View New Version
				</button>
			</div>
		</>
	);
};

// Define the root route
const rootRoute = createRootRoute({
	component: RootLayout,
});

// Define child routes
const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: LandingPage,
});

const benchmarksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/benchmarks",
	component: BenchmarkPage,
});

const docsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/docs",
	component: () => <DocsPage section="installation" />,
});

const docsSectionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/docs/$section",
	component: () => {
		const { section } = docsSectionRoute.useParams();
		return <DocsPage section={section} />;
	},
});

// Create the route tree
const routeTree = rootRoute.addChildren([
	indexRoute,
	benchmarksRoute,
	docsRoute,
	docsSectionRoute,
]);

// Create the router
export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
});

// Register the router for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
