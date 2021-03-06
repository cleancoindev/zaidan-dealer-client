module.exports = {
    plugins: [
        [
            '@vuepress/google-analytics',
            {
                'ga': 'UA-121297415-3            ' // UA-00000000-0
            }
        ]
    ],
    title: "Paradigm Docs",
    head: [
        ['link', { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" }],
        ['link', { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" }],
        ['link', { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" }],
        ['link', { rel: "manifest", href: "/site.webmanifest" }],
        ['link', { rel: "mask-icon", href: "/safari-pinned-tab.svg", color: "#2b5797" }],
        // ['link', { rel: "preload", type: "font/otf", as: "font", crossorigin: "anonymous", href: "/Gilroy-Medium.otf" }],
        ['meta', { name: "msapplication-TileColor", content: "#2b5797" }],
        ['meta', { name: "theme-color", content: "#ffffff" }]
    ],
    description: "Zaidan Documentation and Reference",
    base: "/",
    themeConfig: {
        logo: "/docs-logo.png",
        editLinks: true,
        editLinkText: "View source on GitHub",
        lastUpdated: true,
        sidebarDepth: 3,
        docsRepo: "paradigmfoundation/docs",
        docsDir: "docs",
        nav: [
            { text: 'Home', link: "https://zaidan.io/" }
        ],
        sidebar: [
            {
                title: "Zaidan",
                collapsable: true,
                food: "1.svg",
                children: [
                    "/",
                    "/globals",
                    "classes/dealerclient",
                    "interfaces/dealerresponse",
                    "interfaces/quoteresponse",
                    "interfaces/swapresponse",
                    "interfaces/dealerfilltransaction",
                ]
            },
        ]
    },
}