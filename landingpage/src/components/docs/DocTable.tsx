export const DocTable = ({
	headers,
	rows,
}: { headers: string[]; rows: string[][] }) => (
	<div className="overflow-x-auto border border-white/10 rounded-lg">
		<table className="w-full text-left border-collapse font-mono text-xs md:text-sm">
			<thead className="bg-[#1a1a1a] text-gray-300">
				<tr>
					{headers.map((h, i) => (
						<th
							key={i}
							className="p-3 border-b border-white/10 whitespace-nowrap"
						>
							{h}
						</th>
					))}
				</tr>
			</thead>
			<tbody className="divide-y divide-white/5 text-gray-400 bg-[#0c0c0c]">
				{rows.map((row, i) => (
					<tr key={i}>
						{row.map((cell, j) => (
							<td
								key={j}
								className="p-3 align-top"
								dangerouslySetInnerHTML={{ __html: cell }}
							/>
						))}
					</tr>
				))}
			</tbody>
		</table>
	</div>
);
